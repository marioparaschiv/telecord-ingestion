import { Long, PeersIndex, RawUpdateInfo, type tl } from '@mtcute/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TelegramOpcode, TelegramUpdate } from '@telecord/ingest-client/telegram';
import type { Filter } from '@telecord/producer-core';

import {
	decodeObject,
	dialogOf,
	iterate,
	narrow,
	startHarness,
	vectorChats,
	vectorUpdates,
	type Harness,
} from './fixtures';
import { serialize, serializeVector } from '../src/tl';

const CHANNEL_ID = 1_987_654_321;
const CHANNEL_PEER_ID = '-1001987654321';
const USER_ID = 777_000_123;

let harness: Harness;

afterEach(async () => {
	await harness.close();
	vi.restoreAllMocks();
});

/** The vectors' channel message, re-addressed to another chat and shipped with that chat's copies. */
function messageIn(
	peerId: tl.TypePeer,
	kind: 'updateNewMessage' | 'updateNewChannelMessage' | 'updateEditChannelMessage',
	chats: tl.TypeChat[] = [],
) {
	const container = vectorUpdates();
	const [update] = container.updates;

	if (update?._ !== 'updateNewChannelMessage' || update.message._ !== 'message') {
		throw new Error('event/update does not carry a channel message');
	}

	const message: tl.RawMessage = { ...update.message, peerId };

	return new RawUpdateInfo(
		{ ...update, _: kind, message },
		PeersIndex.from({ ...container, chats: [...container.chats, ...chats] }),
	);
}

/** The chat the next forwarded `UPDATE` frame concerns. */
async function nextUpdatePeer(): Promise<tl.TypePeer | undefined> {
	const frame = await harness.socket.nextFrame();
	const { data } = TelegramUpdate.parse(frame.d);
	const [update] = narrow(decodeObject(data), 'updates').updates;

	switch (update?._) {
		case 'updateNewMessage':
		case 'updateNewChannelMessage':
		case 'updateEditChannelMessage':
			return update.message.peerId;

		default:
			return undefined;
	}
}

async function request(op: TelegramOpcode, payload: object): Promise<unknown> {
	harness.socket.send(op, payload, `nonce-${op}`);

	return (await harness.socket.nextFrame()).d;
}

function mediaFetch(source: object, location: tl.TypeInputFileLocation) {
	return {
		locator: { kind: 'tl', location: serialize(location), dcId: 2 },
		source,
		maxBytes: 1_024,
		upload: { url: 'https://uploads.example.com/bucket', fields: { key: 'object' } },
	};
}

describe('Telegram filter rules', () => {
	it('drops a denied chat from events, requests and the snapshot without calling Telegram', async () => {
		const filter: Filter = {
			rules: [{ action: 'deny', match: { peerId: [CHANNEL_PEER_ID] } }],
			fallback: 'allow',
		};

		harness = await startHarness(filter);

		const { client, producer } = harness;
		const call = vi.spyOn(client, 'call');
		const download = vi.spyOn(client, 'downloadAsIterable');
		const { forum, group } = vectorChats();

		vi.spyOn(client, 'iterDialogs').mockReturnValue(
			iterate([
				dialogOf({ _: 'peerChannel', channelId: forum.id }, [forum]),
				dialogOf({ _: 'peerChat', chatId: group.id }, [group]),
			]),
		);

		producer.updates.onRawUpdate(
			messageIn({ _: 'peerChannel', channelId: CHANNEL_ID }, 'updateNewChannelMessage'),
		);
		producer.updates.onRawUpdate(
			messageIn({ _: 'peerChat', chatId: group.id }, 'updateNewMessage', [group]),
		);

		expect(await nextUpdatePeer()).toEqual({ _: 'peerChat', chatId: group.id });

		expect(
			await request(TelegramOpcode.MESSAGES_FETCH, { peerId: CHANNEL_PEER_ID, ids: [9001] }),
		).toEqual({ ok: false, reason: 'filtered' });

		expect(
			await request(
				TelegramOpcode.MEDIA_FETCH,
				mediaFetch(
					{ kind: 'avatar' },
					{
						_: 'inputPeerPhotoFileLocation',
						big: true,
						peer: {
							_: 'inputPeerChannel',
							channelId: CHANNEL_ID,
							accessHash: forum.accessHash ?? Long.ZERO,
						},
						photoId: Long.fromNumber(1),
					},
				),
			),
		).toEqual({ ok: false, reason: 'filtered' });

		harness.socket.send(TelegramOpcode.CHATS_FETCH, {}, 'snapshot');

		const snapshot = await harness.socket.nextFrame();

		expect(snapshot.d).toEqual({
			part: 0,
			done: true,
			chats: serializeVector([group]),
			users: serializeVector([]),
			topics: [],
		});
		expect(call).not.toHaveBeenCalled();
		expect(download).not.toHaveBeenCalled();
	});

	it('drops private chats by default', async () => {
		harness = await startHarness();

		const { client, producer } = harness;
		const call = vi.spyOn(client, 'call');
		const [user] = vectorUpdates().users;
		const { group } = vectorChats();

		if (user?._ !== 'user') {
			throw new Error('event/update carries no user');
		}

		vi.spyOn(client, 'iterDialogs').mockReturnValue(
			iterate([
				dialogOf({ _: 'peerUser', userId: user.id }, [], [user]),
				dialogOf({ _: 'peerChat', chatId: group.id }, [group]),
			]),
		);

		producer.updates.onRawUpdate(
			messageIn({ _: 'peerUser', userId: USER_ID }, 'updateNewMessage'),
		);
		producer.updates.onRawUpdate(
			messageIn({ _: 'peerChat', chatId: group.id }, 'updateNewMessage', [group]),
		);

		expect(await nextUpdatePeer()).toEqual({ _: 'peerChat', chatId: group.id });

		expect(
			await request(TelegramOpcode.MESSAGES_FETCH, { peerId: String(USER_ID), ids: [1] }),
		).toEqual({ ok: false, reason: 'filtered' });

		harness.socket.send(TelegramOpcode.CHATS_FETCH, {}, 'snapshot');

		expect((await harness.socket.nextFrame()).d).toMatchObject({
			users: serializeVector([]),
			chats: serializeVector([group]),
		});
		expect(call).not.toHaveBeenCalled();
	});

	it('matches update rules on events only, leaving the chat answerable', async () => {
		harness = await startHarness({
			rules: [{ action: 'deny', match: { update: ['updateEditChannelMessage'] } }],
			fallback: 'allow',
		});

		const { client, producer } = harness;
		const channel = { _: 'peerChannel', channelId: CHANNEL_ID } as const;

		vi.spyOn(client, 'call').mockResolvedValue({
			_: 'messages.channelMessages',
			pts: 1,
			count: 0,
			messages: [],
			topics: [],
			chats: [],
			users: [],
		});

		producer.updates.onRawUpdate(messageIn(channel, 'updateEditChannelMessage'));
		producer.updates.onRawUpdate(messageIn(channel, 'updateNewChannelMessage'));

		expect(await nextUpdatePeer()).toEqual(channel);
		expect(
			await request(TelegramOpcode.MESSAGES_FETCH, { peerId: CHANNEL_PEER_ID, ids: [9001] }),
		).toMatchObject({ ok: true });
	});
});
