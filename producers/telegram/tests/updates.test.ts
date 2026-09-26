import { PeersIndex, RawUpdateInfo, type tl } from '@mtcute/node';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TelegramUpdate } from '@telecord/ingest-client/telegram';

import { decodeObject, narrow, startHarness, vectorUpdates, type Harness } from './fixtures';
import { serialize } from '../src/tl';

const CHANNEL_ID = 1_987_654_321;
const GROUP_ID = 4_123_456;

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
		const group: tl.RawChat = {
			_: 'chat',
			id: GROUP_ID,
			title: 'Analytical Society',
			photo: { _: 'chatPhotoEmpty' },
			participantsCount: 3,
			date: 1_758_000_000,
			version: 7,
		};

		const call = vi.spyOn(client, 'call').mockImplementation(async (request) => {
			expect(request).toEqual({ _: 'messages.getChats', id: [GROUP_ID] });

			return { _: 'messages.chats', chats: [group] };
		});

		producer.updates.onRawUpdate(
			new RawUpdateInfo({ _: 'updateChat', chatId: GROUP_ID }, new PeersIndex()),
		);

		const forwarded = narrow(await nextForwarded(), 'updates');

		expect(forwarded.updates).toEqual([{ _: 'updateChat', chatId: GROUP_ID }]);
		expect(forwarded.chats).toMatchObject([group]);
		expect(call).toHaveBeenCalledOnce();
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

		const { user, channel } = vectorPeers();
		const [update] = vectorUpdates().updates;

		if (update?._ !== 'updateNewChannelMessage') {
			throw new Error('event/update carries no channel message');
		}

		const difference: tl.updates.RawChannelDifferenceTooLong = {
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

		harness.producer.updates.onChannelTooLong(CHANNEL_ID, difference);

		expect(await nextForwarded()).toEqual(decodeObject(serialize(difference)));
	});
});
