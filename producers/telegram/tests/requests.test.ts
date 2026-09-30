import { Long, MtPeerNotFoundError, tl } from '@mtcute/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TelegramOpcode } from '@telecord/ingest-client/telegram';
import type { Filter } from '@telecord/producer-core';

import { bytesOf, startHarness, type Harness } from './fixtures';
import { serialize } from '../src/tl';

/** A channel and a user the session has never cached, which Telegram still resolves. */
const CHANNEL_ID = 1_555_666_777;
const CHANNEL_PEER_ID = `-100${CHANNEL_ID}`;
const USER_ID = 888_111_222;
const ACCESS_HASH = Long.fromString('4444444444444444444');

const ALLOW_ALL: Filter = { rules: [], fallback: 'allow' };

const CHANNEL: tl.RawChannel = {
	_: 'channel',
	id: CHANNEL_ID,
	accessHash: ACCESS_HASH,
	title: 'Uncached',
	photo: { _: 'chatPhotoEmpty' },
	date: 1_758_000_000,
	megagroup: true,
};

const USER: tl.RawUser = {
	_: 'user',
	id: USER_ID,
	accessHash: ACCESS_HASH,
	firstName: 'Uncached',
};

const MESSAGE: tl.RawMessage = {
	_: 'message',
	id: 42,
	peerId: { _: 'peerChannel', channelId: CHANNEL_ID },
	date: 1_758_000_000,
	message: 'hello',
	media: {
		_: 'messageMediaDocument',
		document: {
			_: 'document',
			id: Long.fromNumber(7),
			accessHash: Long.fromNumber(8),
			fileReference: new Uint8Array([2, 2, 2]),
			date: 0,
			mimeType: 'image/jpeg',
			size: 700,
			dcId: 4,
			attributes: [],
		},
	},
};

let harness: Harness;

afterEach(async () => {
	await harness.close();
	vi.restoreAllMocks();
});

async function request(op: TelegramOpcode, payload: object): Promise<unknown> {
	harness.socket.send(op, payload, `nonce-${op}`);

	return (await harness.socket.nextFrame()).d;
}

/**
 * Stands in for Telegram. `reachable` says whether mtcute's resolution, past the session's empty
 * cache, finds the uncached channel and user by their ids.
 */
function answerTelegram(reachable: boolean) {
	const resolve = vi.spyOn(harness.client, 'resolvePeer').mockImplementation(async (peerId) => {
		if (!reachable) {
			throw new MtPeerNotFoundError(`Peer ${String(peerId)} is not found in local cache`);
		}

		return peerId === USER_ID
			? { _: 'inputPeerUser', userId: USER_ID, accessHash: ACCESS_HASH }
			: { _: 'inputPeerChannel', channelId: CHANNEL_ID, accessHash: ACCESS_HASH };
	});
	const call = vi.spyOn(harness.client, 'call').mockImplementation(async (method) => {
		switch (method._) {
			case 'users.getUsers':
				return [USER];

			case 'channels.getMessages':
				return {
					_: 'messages.channelMessages',
					pts: 1,
					count: 1,
					messages: [MESSAGE],
					topics: [],
					chats: [CHANNEL],
					users: [],
				};

			default:
				throw new Error(`Unexpected call ${method._}`);
		}
	});

	return { resolve, call };
}

/** The input peer Telegram was asked through, once resolved. */
const RESOLVED_CHANNEL = { _: 'inputChannel', channelId: CHANNEL_ID, accessHash: ACCESS_HASH };
const RESOLVED_USER = { _: 'inputUser', userId: USER_ID, accessHash: ACCESS_HASH };

describe('requests for a peer the session has not cached', () => {
	it('MESSAGES_FETCH resolves the chat through Telegram', async () => {
		harness = await startHarness(ALLOW_ALL);

		const { call } = answerTelegram(true);

		expect(await harness.client.storage.peers.getById(Number(CHANNEL_PEER_ID))).toBeNull();
		expect(
			await request(TelegramOpcode.MESSAGES_FETCH, { peerId: CHANNEL_PEER_ID, ids: [42] }),
		).toMatchObject({ ok: true });
		expect(call).toHaveBeenCalledWith(
			expect.objectContaining({ _: 'channels.getMessages', channel: RESOLVED_CHANNEL }),
			expect.anything(),
		);
	});

	it('USERS_FETCH resolves the user through Telegram', async () => {
		harness = await startHarness(ALLOW_ALL);

		const { call } = answerTelegram(true);

		expect(await request(TelegramOpcode.USERS_FETCH, { userId: USER_ID })).toMatchObject({
			ok: true,
		});
		expect(call).toHaveBeenLastCalledWith({ _: 'users.getUsers', id: [RESOLVED_USER] });
	});

	it('MEDIA_FETCH refreshes a file reference through a source chat Telegram resolves', async () => {
		harness = await startHarness(ALLOW_ALL);

		const { call } = answerTelegram(true);

		vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
		vi.spyOn(harness.client, 'downloadAsIterable')
			.mockImplementationOnce(() => {
				throw new tl.RpcError(400, 'FILE_REFERENCE_EXPIRED');
			})
			.mockImplementationOnce(() => bytesOf(700));

		expect(
			await request(TelegramOpcode.MEDIA_FETCH, {
				locator: {
					kind: 'tl',
					location: serialize({
						_: 'inputDocumentFileLocation',
						id: Long.fromNumber(7),
						accessHash: Long.fromNumber(8),
						fileReference: new Uint8Array([1, 1, 1]),
						thumbSize: '',
					}),
					dcId: 4,
				},
				source: { kind: 'message', peerId: CHANNEL_PEER_ID, messageId: 42 },
				maxBytes: 1_024,
				upload: { url: 'https://uploads.example.com/bucket', fields: { key: 'object' } },
			}),
		).toEqual({ ok: true, bytes: 700 });
		expect(call).toHaveBeenCalledWith(
			expect.objectContaining({ _: 'channels.getMessages', channel: RESOLVED_CHANNEL }),
			expect.anything(),
		);
	});

	it.each([
		[
			TelegramOpcode.MESSAGES_FETCH,
			{ peerId: CHANNEL_PEER_ID, ids: [42] },
			{ ok: false, reason: 'access_lost' },
		],
		[TelegramOpcode.USERS_FETCH, { userId: USER_ID }, { ok: false, reason: 'access_lost' }],
	])(
		'%s answers access_lost for a peer Telegram cannot resolve either',
		async (op, payload, result) => {
			harness = await startHarness(ALLOW_ALL);
			answerTelegram(false);

			expect(await request(op, payload)).toMatchObject(result);
		},
	);

	it('MEDIA_FETCH answers source_context_lost when Telegram cannot resolve the source chat either', async () => {
		harness = await startHarness(ALLOW_ALL);
		answerTelegram(false);

		vi.spyOn(harness.client, 'downloadAsIterable').mockImplementation(() => {
			throw new tl.RpcError(400, 'FILE_REFERENCE_EXPIRED');
		});

		expect(
			await request(TelegramOpcode.MEDIA_FETCH, {
				locator: {
					kind: 'tl',
					location: serialize({
						_: 'inputDocumentFileLocation',
						id: Long.fromNumber(7),
						accessHash: Long.fromNumber(8),
						fileReference: new Uint8Array([1, 1, 1]),
						thumbSize: '',
					}),
					dcId: 4,
				},
				source: { kind: 'message', peerId: CHANNEL_PEER_ID, messageId: 42 },
				maxBytes: 1_024,
				upload: { url: 'https://uploads.example.com/bucket', fields: { key: 'object' } },
			}),
		).toEqual({ ok: false, reason: 'source_context_lost' });
	});

	it('checks the filter rules before asking Telegram to resolve anything', async () => {
		harness = await startHarness({
			rules: [{ action: 'deny', match: { peerId: [CHANNEL_PEER_ID] } }],
			fallback: 'allow',
		});

		const { resolve, call } = answerTelegram(true);

		expect(
			await request(TelegramOpcode.MESSAGES_FETCH, { peerId: CHANNEL_PEER_ID, ids: [42] }),
		).toEqual({ ok: false, reason: 'filtered' });
		expect(resolve).not.toHaveBeenCalled();
		expect(call).not.toHaveBeenCalled();
	});
});
