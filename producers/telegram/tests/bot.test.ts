import { Long, PeersIndex, RawUpdateInfo, User, getMarkedPeerId, type tl } from '@mtcute/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
	TelegramChatsPart,
	TelegramMessagesFetchResult,
	TelegramOpcode,
} from '@telecord/ingest-client/telegram';
import type { Filter } from '@telecord/producer-core';

import {
	SELF,
	decodeObject,
	decodeVector,
	narrow,
	seedPeers,
	startHarness,
	vectorChats,
	vectorUpdates,
	type Harness,
} from './fixtures';
import identify from '../src/identify';
import ChatStore from '../src/chats';

const ALLOW_ALL: Filter = { rules: [], fallback: 'allow' };

const CHANNEL: tl.RawChannel = {
	_: 'channel',
	id: 1_555_666_777,
	accessHash: Long.fromString('4444444444444444444'),
	title: 'Bot Supergroup',
	photo: { _: 'chatPhotoEmpty' },
	date: 1_758_000_000,
	megagroup: true,
};
const CHANNEL_PEER: tl.RawPeerChannel = { _: 'peerChannel', channelId: CHANNEL.id };
const CHANNEL_MARKED_ID = getMarkedPeerId(CHANNEL_PEER);

let harness: Harness;
let chats: ChatStore;

async function startBot(filter: Filter = ALLOW_ALL): Promise<void> {
	harness = await startHarness(filter, chats);
	await harness.client.storage.self.store({
		userId: SELF.id,
		isBot: true,
		isPremium: false,
		usernames: [],
	});
}

beforeEach(() => {
	chats = new ChatStore(':memory:');
});

afterEach(async () => {
	await harness.close();
	chats.close();
	vi.restoreAllMocks();
});

async function request(op: TelegramOpcode, payload: object): Promise<unknown> {
	harness.socket.send(op, payload, `nonce-${op}`);

	return (await harness.socket.nextFrame()).d;
}

/** The vectors' channel message, with the chat and user that ship with it. */
function vectorMessage() {
	const container = vectorUpdates();
	const [update] = container.updates;

	if (update?._ !== 'updateNewChannelMessage' || update.message._ !== 'message') {
		throw new Error('event/update does not carry a channel message');
	}

	return {
		update,
		message: update.message,
		peers: PeersIndex.from(container),
		chatId: getMarkedPeerId(update.message.peerId),
	};
}

function membership(
	channelId: number,
	userId: number,
	newParticipant?: tl.TypeChannelParticipant,
): tl.RawUpdateChannelParticipant {
	return {
		_: 'updateChannelParticipant',
		channelId,
		date: 1_758_000_000,
		actorId: 555_000_111,
		userId,
		newParticipant,
		qts: 1,
	};
}

function messageOf(id: number, peerId: tl.TypePeer = CHANNEL_PEER): tl.RawMessage {
	return { _: 'message', id, peerId, date: 1_758_000_000, message: `message ${id}` };
}

/** The ids of the messages a `MESSAGES_FETCH_RESULT` carries, in the order it carries them. */
function fetchedIds(result: unknown): number[] {
	const { messages } = TelegramMessagesFetchResult.parse(result);

	return narrow(decodeObject(messages), 'messages.messages').messages.map(({ id }) => id);
}

describe('the chats a bot learns', () => {
	it('learns a chat and its newest message from the updates that name it', async () => {
		await startBot();

		const { update, message, peers, chatId } = vectorMessage();
		const edit: tl.RawUpdateEditChannelMessage = {
			...update,
			_: 'updateEditChannelMessage',
			message: { ...message, id: message.id - 1 },
		};

		harness.producer.updates.onRawUpdate(new RawUpdateInfo(update, peers));
		harness.producer.updates.onRawUpdate(new RawUpdateInfo(edit, peers));

		expect(chats.all()).toEqual([{ peerId: chatId, topMessage: message.id }]);
	});

	it('learns a chat the filter rules block, so it can still be listed', async () => {
		const { update, peers, chatId } = vectorMessage();

		await startBot({
			rules: [{ action: 'deny', match: { peerId: [String(chatId)] } }],
			fallback: 'allow',
		});
		harness.producer.updates.onRawUpdate(new RawUpdateInfo(update, peers));

		expect(chats.all().map(({ peerId }) => peerId)).toEqual([chatId]);
	});

	it('forgets a chat once an update shows the bot out of it', async () => {
		await startBot();

		const { update, message, peers, chatId } = vectorMessage();
		const { channelId } = narrow(message.peerId, 'peerChannel');

		harness.producer.updates.onRawUpdate(new RawUpdateInfo(update, peers));
		harness.producer.updates.onRawUpdate(
			new RawUpdateInfo(membership(channelId, 555_000_111), peers),
		);

		expect(chats.topMessage(chatId)).toBe(message.id);

		harness.producer.updates.onRawUpdate(
			new RawUpdateInfo(membership(channelId, SELF.id), peers),
		);

		expect(chats.all()).toEqual([]);
	});

	it('learns nothing from an update that only says a chat changed', async () => {
		await startBot();

		const { message, peers } = vectorMessage();
		const { channelId } = narrow(message.peerId, 'peerChannel');

		harness.producer.updates.onRawUpdate(
			new RawUpdateInfo({ _: 'updateChannel', channelId }, peers),
		);

		expect(chats.all()).toEqual([]);
	});
});

describe('a bot snapshot', () => {
	it('names the learned chats with their newest messages, without listing dialogs or topics', async () => {
		await startBot();

		const { forum, group } = vectorChats();
		const iterDialogs = vi.spyOn(harness.client, 'iterDialogs');
		const call = vi.spyOn(harness.client, 'call').mockImplementation(async (method) => {
			switch (method._) {
				case 'channels.getChannels':
					return { _: 'messages.chats', chats: [forum] };

				case 'messages.getChats':
					return { _: 'messages.chats', chats: [group] };

				default:
					throw new Error(`Unexpected call ${method._}`);
			}
		});

		await seedPeers(harness.client, { chats: [forum, group] });
		chats.learn(getMarkedPeerId(forum.id, 'channel'), 11);
		chats.learn(getMarkedPeerId(group.id, 'chat'));

		const part = TelegramChatsPart.parse(await request(TelegramOpcode.CHATS_FETCH, {}));

		expect(decodeVector(part.chats)).toEqual([forum, group]);
		expect(part.topics).toEqual([]);
		expect(part.topMessages).toEqual([{ peerId: `-100${forum.id}`, messageId: 11 }]);
		expect(part.done).toBe(true);
		expect(iterDialogs).not.toHaveBeenCalled();
		expect(call).toHaveBeenCalledTimes(2);
	});

	it('forgets a learned chat Telegram shows the bot out of', async () => {
		await startBot();

		const { group } = vectorChats();
		const groupId = getMarkedPeerId(group.id, 'chat');

		vi.spyOn(harness.client, 'call').mockResolvedValue({
			_: 'messages.chats',
			chats: [{ ...group, left: true }],
		});
		chats.learn(groupId, 4);

		const part = TelegramChatsPart.parse(await request(TelegramOpcode.CHATS_FETCH, {}));

		expect(part.chats).toBeUndefined();
		expect(part.done).toBe(true);
		expect(chats.topMessage(groupId)).toBeUndefined();
	});

	it('never fetches a learned private chat the rules block', async () => {
		await startBot({ rules: [], fallback: 'deny' });

		const call = vi.spyOn(harness.client, 'call');

		chats.learn(555_000_111, 3);
		await request(TelegramOpcode.CHATS_FETCH, {});

		expect(call).not.toHaveBeenCalled();
		expect(chats.topMessage(555_000_111)).toBe(3);
	});
});

describe('a page of history read by a bot', () => {
	/** Answers `getMessages` as a chat whose even ids are messages and whose odd ids are deleted. */
	function answerWithEvenIds() {
		return vi.spyOn(harness.client, 'call').mockImplementation(async (method) => {
			if (method._ !== 'channels.getMessages') {
				throw new Error(`Unexpected call ${method._}`);
			}

			return {
				_: 'messages.channelMessages',
				pts: 1,
				count: method.id.length,
				messages: method.id.map((input): tl.TypeMessage => {
					const { id } = narrow(input, 'inputMessageID');

					return id % 2 === 0 ? messageOf(id) : { _: 'messageEmpty', id };
				}),
				topics: [],
				chats: [CHANNEL],
				users: [],
			};
		});
	}

	function requestedIds(call: ReturnType<typeof answerWithEvenIds>): number[][] {
		return call.mock.calls.map(([method]) =>
			narrow(method, 'channels.getMessages').id.map(
				(input) => narrow(input, 'inputMessageID').id,
			),
		);
	}

	beforeEach(async () => {
		await startBot();
		await seedPeers(harness.client, { chats: [CHANNEL] });
	});

	it('walks ids upwards from `after` until the page is full, skipping deleted ones', async () => {
		const call = answerWithEvenIds();

		chats.learn(CHANNEL_MARKED_ID, 250);

		const ids = fetchedIds(
			await request(TelegramOpcode.MESSAGES_FETCH, {
				peerId: String(CHANNEL_MARKED_ID),
				after: 100,
				limit: 60,
			}),
		);

		expect(ids).toHaveLength(60);
		expect(ids.at(0)).toBe(220);
		expect(ids.at(-1)).toBe(102);
		expect(requestedIds(call).map((window) => [window.at(0), window.at(-1)])).toEqual([
			[101, 200],
			[201, 250],
		]);
		expect(call).not.toHaveBeenCalledWith(
			expect.objectContaining({ _: 'messages.getHistory' }),
			expect.anything(),
		);
	});

	it('walks ids downwards from the newest message seen for the latest page', async () => {
		const call = answerWithEvenIds();

		chats.learn(CHANNEL_MARKED_ID, 250);

		expect(
			fetchedIds(
				await request(TelegramOpcode.MESSAGES_FETCH, {
					peerId: String(CHANNEL_MARKED_ID),
					limit: 5,
				}),
			),
		).toEqual([250, 248, 246, 244, 242]);
		expect(requestedIds(call).map((window) => [window.at(0), window.at(-1)])).toEqual([
			[151, 250],
		]);
	});

	it('answers an empty page for a chat it never saw a message in, without calling Telegram', async () => {
		const call = answerWithEvenIds();

		expect(
			fetchedIds(
				await request(TelegramOpcode.MESSAGES_FETCH, {
					peerId: String(CHANNEL_MARKED_ID),
					after: 100,
					limit: 60,
				}),
			),
		).toEqual([]);
		expect(call).not.toHaveBeenCalled();
	});

	it('stops at the window cap and answers the short page', async () => {
		const call = vi.spyOn(harness.client, 'call').mockImplementation(async (method) => ({
			_: 'messages.channelMessages',
			pts: 1,
			count: 0,
			messages: narrow(method, 'channels.getMessages').id.map((input): tl.TypeMessage => ({
				_: 'messageEmpty',
				id: narrow(input, 'inputMessageID').id,
			})),
			topics: [],
			chats: [],
			users: [],
		}));

		chats.learn(CHANNEL_MARKED_ID, 1_000_000);

		expect(
			fetchedIds(
				await request(TelegramOpcode.MESSAGES_FETCH, {
					peerId: String(CHANNEL_MARKED_ID),
					after: 1,
					limit: 100,
				}),
			),
		).toEqual([]);
		expect(call).toHaveBeenCalledTimes(50);
	});

	it("drops other chats' messages from a window outside channels", async () => {
		const { group } = vectorChats();
		const groupPeer: tl.RawPeerChat = { _: 'peerChat', chatId: group.id };
		const groupId = getMarkedPeerId(groupPeer);

		vi.spyOn(harness.client, 'call').mockImplementation(async (method) => ({
			_: 'messages.messages',
			messages: narrow(method, 'messages.getMessages').id.map((input) => {
				const { id } = narrow(input, 'inputMessageID');

				return messageOf(id, id % 2 === 0 ? groupPeer : { _: 'peerUser', userId: 5 });
			}),
			topics: [],
			chats: [group],
			users: [],
		}));
		chats.learn(groupId, 10);

		expect(
			fetchedIds(
				await request(TelegramOpcode.MESSAGES_FETCH, { peerId: String(groupId), limit: 5 }),
			),
		).toEqual([10, 8, 6, 4, 2]);
	});
});

describe('a bot IDENTIFY', () => {
	it('leaves FORUM_TOPICS_FETCH undeclared, since a bot cannot list topics', async () => {
		await startBot();
		vi.spyOn(harness.client, 'getMe').mockResolvedValue(new User({ ...SELF, bot: true }));

		expect(await identify(harness.client, true)).toMatchObject({
			bot: true,
			requests: [TelegramOpcode.CUSTOM_EMOJIS_FETCH],
		});
	});
});
