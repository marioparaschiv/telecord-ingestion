import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { PeersIndex, RawUpdateInfo, getMarkedPeerId, type tl } from '@mtcute/node';

import { TelegramUpdate } from '@telecord/ingest-client/telegram';
import { Outbox, type Filter } from '@telecord/producer-core';

import {
	DEFAULT_FILTER,
	decodeObject,
	narrow,
	startHarness,
	vectorUpdates,
	type Harness,
} from './fixtures';
import { createUpdateForwarder } from '../src/updates';
import { serialize } from '../src/tl';

const CHANNEL_ID = 1_987_654_321;
const GROUP_ID = 4_123_456;
const DM_USER_ID = 5_551_234_567;

/** Lets private chats through, which the default rules deny. */
const ALLOW_PRIVATE: Filter = { rules: [], fallback: 'allow' };

const GROUP: tl.RawChat = {
	_: 'chat',
	id: GROUP_ID,
	title: 'Analytical Society',
	photo: { _: 'chatPhotoEmpty' },
	participantsCount: 3,
	date: 1_758_000_000,
	version: 7,
};

let harness: Harness;

afterEach(async () => {
	await harness.close();
	vi.restoreAllMocks();
});

/** The TL object the next `UPDATE` frame carries. */
async function nextForwarded(): Promise<tl.TlObject> {
	const frame = await harness.socket.nextFrame();

	return decodeObject(TelegramUpdate.parse(frame.d).data);
}

function vectorPeers() {
	const { users, chats } = vectorUpdates();
	const [user] = users;
	const [channel] = chats;

	if (user?._ !== 'user' || channel?._ !== 'channel') {
		throw new Error('event/update lost its user or channel');
	}

	return { user, channel };
}

/** A too-long difference of the vectors' channel, carrying its one message. */
function channelDifference(): tl.updates.RawChannelDifferenceTooLong {
	const { user, channel } = vectorPeers();
	const [update] = vectorUpdates().updates;

	if (update?._ !== 'updateNewChannelMessage') {
		throw new Error('event/update carries no channel message');
	}

	return {
		_: 'updates.channelDifferenceTooLong',
		final: true,
		dialog: {
			_: 'dialog',
			peer: { _: 'peerChannel', channelId: CHANNEL_ID },
			topMessage: update.message.id,
			readInboxMaxId: 0,
			readOutboxMaxId: 0,
			unreadCount: 1,
			unreadMentionsCount: 0,
			unreadReactionsCount: 0,
			unreadPollVotesCount: 0,
			notifySettings: { _: 'peerNotifySettings' },
			pts: 6_000,
		},
		messages: [update.message],
		chats: [channel],
		users: [user],
	};
}

describe('Telegram update forwarding', () => {
	it('replaces a min user with the complete copy the session cached', async () => {
		harness = await startHarness();

		const container = vectorUpdates();
		const { user, channel } = vectorPeers();
		const [update] = container.updates;
		const minUser: tl.RawUser = { ...user, min: true, accessHash: undefined, phone: undefined };

		if (!update) {
			throw new Error('event/update carries no update');
		}

		harness.producer.updates.onRawUpdate(
			new RawUpdateInfo(update, PeersIndex.from({ users: [minUser], chats: [channel] })),
		);

		const forwarded = narrow(await nextForwarded(), 'updates');

		expect(forwarded.users).toEqual([user]);
	});

	it('ships the cached full chat with a state update that carried a min copy', async () => {
		harness = await startHarness();

		const { client, producer } = harness;
		const { channel } = vectorPeers();
		const call = vi.spyOn(client, 'call');

		producer.updates.onRawUpdate(
			new RawUpdateInfo(
				{ _: 'updateChannel', channelId: CHANNEL_ID },
				PeersIndex.from({ chats: [{ ...channel, min: true }] }),
			),
		);

		const forwarded = narrow(await nextForwarded(), 'updates');

		expect(forwarded.updates).toEqual([{ _: 'updateChannel', channelId: CHANNEL_ID }]);
		expect(forwarded.chats).toEqual([channel]);
		expect(call).not.toHaveBeenCalled();
	});

	it('fetches the full chat for a state update when the session has none', async () => {
		harness = await startHarness();

		const { client, producer } = harness;
		const call = vi.spyOn(client, 'call').mockImplementation(async (request) => {
			expect(request).toEqual({ _: 'messages.getChats', id: [GROUP_ID] });

			return { _: 'messages.chats', chats: [GROUP] };
		});

		producer.updates.onRawUpdate(
			new RawUpdateInfo({ _: 'updateChat', chatId: GROUP_ID }, new PeersIndex()),
		);

		const forwarded = narrow(await nextForwarded(), 'updates');

		expect(forwarded.updates).toEqual([{ _: 'updateChat', chatId: GROUP_ID }]);
		expect(forwarded.chats).toMatchObject([GROUP]);
		expect(call).toHaveBeenCalledOnce();
	});

	it.each(['updateNewChannelMessage', 'updateEditChannelMessage'] as const)(
		'ships the complete channel with %s when it came with a min copy',
		async (kind) => {
			harness = await startHarness();

			const { client, producer } = harness;
			const { channel } = vectorPeers();
			const [update] = vectorUpdates().updates;
			const call = vi.spyOn(client, 'call');

			if (update?._ !== 'updateNewChannelMessage') {
				throw new Error('event/update carries no channel message');
			}

			producer.updates.onRawUpdate(
				new RawUpdateInfo(
					{ ...update, _: kind },
					PeersIndex.from({ chats: [{ ...channel, min: true }] }),
				),
			);

			const forwarded = narrow(await nextForwarded(), 'updates');

			expect(forwarded.chats).toEqual([channel]);
			expect(call).not.toHaveBeenCalled();
		},
	);

	it.each(['updateNewMessage', 'updateEditMessage'] as const)(
		'fetches the full chat for %s in a group the session has no copy of',
		async (kind) => {
			harness = await startHarness();

			const { client, producer } = harness;
			const [update] = vectorUpdates().updates;

			if (update?._ !== 'updateNewChannelMessage' || update.message._ !== 'message') {
				throw new Error('event/update carries no channel message');
			}

			const call = vi.spyOn(client, 'call').mockResolvedValue({
				_: 'messages.chats',
				chats: [GROUP],
			});

			producer.updates.onRawUpdate(
				new RawUpdateInfo(
					{
						_: kind,
						message: { ...update.message, peerId: { _: 'peerChat', chatId: GROUP_ID } },
						pts: 10,
						ptsCount: 1,
					},
					new PeersIndex(),
				),
			);

			const forwarded = narrow(await nextForwarded(), 'updates');

			expect(forwarded.chats).toMatchObject([GROUP]);
			expect(call).toHaveBeenCalledExactlyOnceWith({
				_: 'messages.getChats',
				id: [GROUP_ID],
			});
		},
	);

	it('ships the complete group a message came with, without calling Telegram', async () => {
		harness = await startHarness();

		const { client, producer } = harness;
		const [update] = vectorUpdates().updates;
		const call = vi.spyOn(client, 'call');

		if (update?._ !== 'updateNewChannelMessage' || update.message._ !== 'message') {
			throw new Error('event/update carries no channel message');
		}

		producer.updates.onRawUpdate(
			new RawUpdateInfo(
				{
					_: 'updateNewMessage',
					message: { ...update.message, peerId: { _: 'peerChat', chatId: GROUP_ID } },
					pts: 10,
					ptsCount: 1,
				},
				PeersIndex.from({ chats: [GROUP] }),
			),
		);

		const forwarded = narrow(await nextForwarded(), 'updates');

		expect(forwarded.chats).toMatchObject([GROUP]);
		expect(call).not.toHaveBeenCalled();
	});

	it('fetches the full user for a private message whose user came min and is not cached', async () => {
		harness = await startHarness(ALLOW_PRIVATE);

		const { client, producer } = harness;
		const { user } = vectorPeers();
		const [update] = vectorUpdates().updates;
		const contact: tl.RawUser = { ...user, id: DM_USER_ID };
		const minContact: tl.RawUser = { ...contact, min: true, accessHash: undefined };

		if (update?._ !== 'updateNewChannelMessage' || update.message._ !== 'message') {
			throw new Error('event/update carries no channel message');
		}

		// Where the session last saw the min user, which is how it addresses them.
		await client.storage.refMsgs.store(DM_USER_ID, getMarkedPeerId(CHANNEL_ID, 'channel'), 42);

		const call = vi.spyOn(client, 'call').mockResolvedValue([contact]);

		producer.updates.onRawUpdate(
			new RawUpdateInfo(
				{
					_: 'updateNewMessage',
					message: { ...update.message, peerId: { _: 'peerUser', userId: DM_USER_ID } },
					pts: 10,
					ptsCount: 1,
				},
				PeersIndex.from({ users: [minContact] }),
			),
		);

		const forwarded = narrow(await nextForwarded(), 'updates');

		expect(forwarded.users).toMatchObject([contact]);
		expect(call).toHaveBeenCalledExactlyOnceWith({
			_: 'users.getUsers',
			id: [
				{
					_: 'inputUserFromMessage',
					peer: { _: 'inputPeerChannel', channelId: CHANNEL_ID, accessHash: expect.anything() },
					msgId: 42,
					userId: DM_USER_ID,
				},
			],
		});
	});

	it('ships the complete user a private message came with, without calling Telegram', async () => {
		harness = await startHarness(ALLOW_PRIVATE);

		const { client, producer } = harness;
		const { user } = vectorPeers();
		const [update] = vectorUpdates().updates;
		const contact: tl.RawUser = { ...user, id: DM_USER_ID };
		const call = vi.spyOn(client, 'call');

		if (update?._ !== 'updateNewChannelMessage' || update.message._ !== 'message') {
			throw new Error('event/update carries no channel message');
		}

		producer.updates.onRawUpdate(
			new RawUpdateInfo(
				{
					_: 'updateNewMessage',
					message: { ...update.message, peerId: { _: 'peerUser', userId: DM_USER_ID } },
					pts: 10,
					ptsCount: 1,
				},
				PeersIndex.from({ users: [contact] }),
			),
		);

		const forwarded = narrow(await nextForwarded(), 'updates');

		expect(forwarded.users).toMatchObject([contact]);
		expect(call).not.toHaveBeenCalled();
	});

	it('forwards only the thirteen update constructors', async () => {
		harness = await startHarness();

		harness.producer.updates.onRawUpdate(
			new RawUpdateInfo(
				{ _: 'updateUserStatus', userId: 1, status: { _: 'userStatusEmpty' } },
				new PeersIndex(),
			),
		);
		harness.producer.updates.onRawUpdate(
			new RawUpdateInfo(
				{ _: 'updateDeleteMessages', messages: [1, 2], pts: 10, ptsCount: 2 },
				new PeersIndex(),
			),
		);

		const forwarded = narrow(await nextForwarded(), 'updates');

		expect(forwarded.updates).toEqual([
			{ _: 'updateDeleteMessages', messages: [1, 2], pts: 10, ptsCount: 2 },
		]);
	});

	it('forwards a channel difference too long to replay as it came', async () => {
		harness = await startHarness();

		const difference = channelDifference();

		harness.producer.updates.onChannelTooLong(difference);

		expect(await nextForwarded()).toEqual(decodeObject(serialize(difference)));
	});

	it('forwards what a previous run captured but never stored, ahead of new updates', async () => {
		harness = await startHarness();

		const { client } = harness;
		const outbox = new Outbox(':memory:');

		onTestFinished(() => outbox.close());

		const send = (payload: { data: Uint8Array }, capture: number) =>
			outbox.append(() => payload.data, capture);
		const container = vectorUpdates();
		const [update] = container.updates;
		const stopped = createUpdateForwarder({ client, filter: DEFAULT_FILTER, outbox, send });

		if (!update) {
			throw new Error('event/update carries no update');
		}

		stopped.onRawUpdate(new RawUpdateInfo(update, PeersIndex.from(container)));
		stopped.onChannelTooLong(channelDifference());

		expect(outbox.captures()).toHaveLength(2);

		const restarted = createUpdateForwarder({ client, filter: DEFAULT_FILTER, outbox, send });

		restarted.onRawUpdate(
			new RawUpdateInfo(
				{ _: 'updateDeleteMessages', messages: [1], pts: 10, ptsCount: 1 },
				new PeersIndex(),
			),
		);
		restarted.start();

		await vi.waitFor(() => expect(outbox.size).toBe(3));

		const forwarded = outbox.after(0, 3).map(({ frame }) => {
			const object = decodeObject(frame);

			return object._ === 'updates' ? object.updates[0]?._ : object._;
		});

		expect(forwarded).toEqual([
			'updateNewChannelMessage',
			'updates.channelDifferenceTooLong',
			'updateDeleteMessages',
		]);
		expect(outbox.captures()).toEqual([]);
	});
});
