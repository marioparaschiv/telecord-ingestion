import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Long, tl } from '@mtcute/node';

import { TelegramOpcode } from '@telecord/ingest-client/telegram';

import { bytesOf, startHarness, vectorUpdates, type Harness } from './fixtures';
import { serialize } from '../src/tl';

const CHANNEL_PEER_ID = '-1001987654321';
const DOCUMENT_ID = Long.fromString('5368324170671202286');
const EXPIRED_REFERENCE = new Uint8Array([1, 1, 1]);
const FRESH_REFERENCE = new Uint8Array([2, 2, 2]);

let harness: Harness;

beforeEach(async () => {
	harness = await startHarness();
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(async () => {
	await harness.close();
	vi.restoreAllMocks();
});

function documentLocation(fileReference: Uint8Array): tl.RawInputDocumentFileLocation {
	return {
		_: 'inputDocumentFileLocation',
		id: DOCUMENT_ID,
		accessHash: Long.fromNumber(99),
		fileReference,
		thumbSize: '',
	};
}

async function mediaFetch(
	source: object,
	location: tl.TypeInputFileLocation = documentLocation(EXPIRED_REFERENCE),
): Promise<unknown> {
	harness.socket.send(
		TelegramOpcode.MEDIA_FETCH,
		{
			locator: {
				kind: 'tl',
				location: serialize(location),
				dcId: 4,
			},
			source,
			maxBytes: 1_024,
			upload: { url: 'https://uploads.example.com/bucket', fields: { key: 'object' } },
		},
		'media',
	);

	return (await harness.socket.nextFrame()).d;
}

function expired(): never {
	throw new tl.RpcError(400, 'FILE_REFERENCE_EXPIRED');
}

describe('MEDIA_FETCH', () => {
	it('refreshes an expired file reference through the source message and retries once', async () => {
		const { client } = harness;
		const [update] = vectorUpdates().updates;

		if (update?._ !== 'updateNewChannelMessage' || update.message._ !== 'message') {
			throw new Error('event/update carries no channel message');
		}

		const withDocument: tl.RawMessage = {
			...update.message,
			media: {
				_: 'messageMediaDocument',
				document: {
					_: 'document',
					id: DOCUMENT_ID,
					accessHash: Long.fromNumber(99),
					fileReference: FRESH_REFERENCE,
					date: 0,
					mimeType: 'image/jpeg',
					size: 700,
					dcId: 4,
					attributes: [],
				},
			},
		};

		const download = vi
			.spyOn(client, 'downloadAsIterable')
			.mockImplementationOnce(expired)
			.mockImplementationOnce(() => bytesOf(700));
		const call = vi.spyOn(client, 'call').mockResolvedValue({
			_: 'messages.channelMessages',
			pts: 1,
			count: 1,
			messages: [withDocument],
			topics: [],
			chats: [],
			users: [],
		});

		expect(
			await mediaFetch({
				kind: 'message',
				peerId: CHANNEL_PEER_ID,
				messageId: withDocument.id,
			}),
		).toEqual({ ok: true, bytes: 700 });
		expect(call).toHaveBeenCalledWith(
			expect.objectContaining({
				_: 'channels.getMessages',
				id: [{ _: 'inputMessageID', id: withDocument.id }],
			}),
			expect.anything(),
		);
		expect(download).toHaveBeenLastCalledWith(documentLocation(FRESH_REFERENCE), {
			dcId: 4,
			stallTimeout: 60_000,
		});
	});

	it('answers expired for an avatar, which has no message to refresh through', async () => {
		vi.spyOn(harness.client, 'downloadAsIterable').mockImplementation(expired);

		expect(await mediaFetch({ kind: 'avatar' })).toEqual({ ok: false, reason: 'expired' });
	});

	it("uploads a user's photo, which the default DM rule does not filter", async () => {
		vi.spyOn(harness.client, 'downloadAsIterable').mockImplementation(() => bytesOf(700));

		expect(
			await mediaFetch(
				{ kind: 'avatar' },
				{
					_: 'inputPeerPhotoFileLocation',
					big: false,
					peer: { _: 'inputPeerUser', userId: 777000, accessHash: Long.fromNumber(5) },
					photoId: Long.fromNumber(1),
				},
			),
		).toEqual({ ok: true, bytes: 700 });
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('refuses a file larger than maxBytes without uploading it', async () => {
		vi.spyOn(harness.client, 'downloadAsIterable').mockImplementation(() => bytesOf(2_048));

		expect(await mediaFetch({ kind: 'avatar' })).toEqual({
			ok: false,
			message: 'The file is larger than 1024 bytes',
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});
