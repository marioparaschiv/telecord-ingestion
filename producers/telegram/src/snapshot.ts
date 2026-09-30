import type { Dialog, TelegramClient, tl } from '@mtcute/node';

import {
	asError,
	createTaggedLogger,
	defineSnapshot,
	isAllowed,
	type Filter,
	type RequestHandler,
} from '@telecord/producer-core';
import {
	TelegramChatsPart,
	TelegramOpcode,
	type TelegramChatsPartPayload,
} from '@telecord/ingest-client/telegram';
import { CHATS_PART_MAX_CHATS } from '@telecord/ingest-client';
import { traceRequest } from '@telecord/producer-otel';

import { fetchFullChat, isComplete, markedIdOf, subjectOfRaw } from './peers';
import { serialize, serializeVector } from './tl';

/** Telegram's cap on the topics one `messages.getForumTopics` page lists. */
const FORUM_TOPICS_PAGE_LIMIT = 100;

/** The most topic pages one part may carry. */
const PART_MAX_TOPIC_PAGES = 1_000;

/** The most chats and users one snapshot may name together. */
export const SNAPSHOT_MAX_PEERS = 50_000;

/** The most topics one snapshot may carry. */
const SNAPSHOT_MAX_TOPICS = 100_000;

const logger = createTaggedLogger('Telegram Snapshot');

type TopMessage = NonNullable<TelegramChatsPartPayload['topMessages']>[number];

type TelegramChatsPartFields = Pick<TelegramChatsPartPayload, 'topMessages'> & {
	chats: Uint8Array<ArrayBuffer>;
	users: Uint8Array<ArrayBuffer>;
	topics: Uint8Array<ArrayBuffer>[];
};

function toPart(
	chats: readonly tl.TypeChat[],
	users: readonly tl.TypeUser[],
	topMessages: readonly TopMessage[],
	topics: readonly tl.messages.RawForumTopics[] = [],
): TelegramChatsPartFields {
	return {
		chats: serializeVector(chats),
		users: serializeVector(users),
		topics: topics.map((page) => serialize(page)),
		...(topMessages.length > 0 && { topMessages: [...topMessages] }),
	};
}

/** A dialog's newest message under its marked peer id, or undefined for a dialog without one. */
function topMessageOf({ peer, raw }: Dialog): TopMessage | undefined {
	if (raw.topMessage <= 0) {
		return undefined;
	}

	return { peerId: String(peer.id), messageId: raw.topMessage };
}

/**
 * Every raw `messages.forumTopics` page of a forum, deleted topics included.
 *
 * Paged by the last live topic's offset, the way mtcute pages them. A page that
 * lists no topic not already seen ends the walk, so a stuck offset on an
 * untrusted response cannot loop.
 */
async function forumTopicPages(
	client: TelegramClient,
	forum: tl.RawChannel,
): Promise<tl.messages.RawForumTopics[]> {
	if (!forum.accessHash) {
		return [];
	}

	const peer: tl.TypeInputPeer = {
		_: 'inputPeerChannel',
		channelId: forum.id,
		accessHash: forum.accessHash,
	};
	const pages: tl.messages.RawForumTopics[] = [];
	const seen = new Set<number>();
	let offset = { offsetDate: 0, offsetId: 0, offsetTopic: 0 };

	while (true) {
		const page = await client.call({
			_: 'messages.getForumTopics',
			peer,
			...offset,
			limit: FORUM_TOPICS_PAGE_LIMIT,
		});
		const fresh = page.topics.filter((topic) => !seen.has(topic.id));

		if (fresh.length === 0) {
			return pages;
		}

		for (const topic of fresh) {
			seen.add(topic.id);
		}

		pages.push(page);

		const last = page.topics.findLast((topic) => topic._ === 'forumTopic');

		if (!last || page.topics.length < FORUM_TOPICS_PAGE_LIMIT) {
			return pages;
		}

		const top = page.messages.find((message) => message.id === last.topMessage);
		const lastActivity = top && top._ !== 'messageEmpty' ? top.date : last.date;

		offset = {
			offsetDate: page.orderByCreateDate ? last.date : lastActivity,
			offsetId: last.topMessage,
			offsetTopic: last.id,
		};
	}
}

/** A forum's topic pages, or none when they fail to load, which leaves its stored topics as they are. */
async function loadTopicPages(
	client: TelegramClient,
	forum: tl.RawChannel,
): Promise<tl.messages.RawForumTopics[]> {
	try {
		return await forumTopicPages(client, forum);
	} catch (error) {
		logger.warn(`Failed to fetch the topics of forum ${forum.id}: ${asError(error).message}`);

		return [];
	}
}

/** The full copy of a dialog's chat, fetched when the dialog listed a min copy. */
async function completeChat(client: TelegramClient, chat: tl.TypeChat): Promise<tl.TypeChat> {
	const markedId = markedIdOf(chat);

	if (isComplete(chat) || markedId === undefined) {
		return chat;
	}

	return (await fetchFullChat(client, markedId)) ?? chat;
}

/**
 * The account's chats as snapshot parts, walked from its dialogs: each forum
 * in a part of its own with its topic pages, every other chat and private
 * chat counterpart batched up to the per-part cap. Each part names the newest
 * message of its chats. Chats the filter rules block are left out.
 *
 * Forums are walked one after another, since Telegram flood-limits bursts of
 * topic requests, and each part is yielded as soon as it is complete.
 */
async function* snapshotParts(
	client: TelegramClient,
	filter: Filter,
): AsyncGenerator<TelegramChatsPartFields> {
	let chats: tl.TypeChat[] = [];
	let users: tl.TypeUser[] = [];
	let topMessages: TopMessage[] = [];
	let peerCount = 0;
	let topicCount = 0;

	for await (const dialog of client.iterDialogs({ archived: 'keep' })) {
		const { peer } = dialog;

		if (!isAllowed(filter, subjectOfRaw(peer.raw))) {
			continue;
		}

		if (++peerCount > SNAPSHOT_MAX_PEERS) {
			throw new Error(`The account has more than ${SNAPSHOT_MAX_PEERS} chats`);
		}

		const topMessage = topMessageOf(dialog);

		if (peer.raw._ === 'user') {
			users.push(peer.raw);
		} else {
			const chat = await completeChat(client, peer.raw);

			if (chat._ === 'channel' && chat.forum) {
				const pages = await loadTopicPages(client, chat);

				topicCount += pages.reduce((total, page) => total + page.topics.length, 0);

				if (topicCount > SNAPSHOT_MAX_TOPICS) {
					throw new Error(
						`The account's forums have more than ${SNAPSHOT_MAX_TOPICS} topics`,
					);
				}

				for (
					let start = 0;
					start === 0 || start < pages.length;
					start += PART_MAX_TOPIC_PAGES
				) {
					yield toPart(
						start === 0 ? [chat] : [],
						[],
						start === 0 && topMessage ? [topMessage] : [],
						pages.slice(start, start + PART_MAX_TOPIC_PAGES),
					);
				}

				continue;
			}

			chats.push(chat);
		}

		if (topMessage) {
			topMessages.push(topMessage);
		}

		if (chats.length === CHATS_PART_MAX_CHATS || users.length === CHATS_PART_MAX_CHATS) {
			yield toPart(chats, users, topMessages);
			chats = [];
			users = [];
			topMessages = [];
		}
	}

	if (chats.length > 0 || users.length > 0) {
		yield toPart(chats, users, topMessages);
	}
}

/**
 * The `CHATS_FETCH` handler of a Telegram producer.
 *
 * @param client - The logged-in session.
 * @param filter - The producer's filter rules.
 * @returns The handler.
 */
export function createTelegramSnapshot(client: TelegramClient, filter: Filter): RequestHandler {
	return traceRequest(
		'telegram.chats_fetch',
		{ 'telecord.platform': 'telegram', 'telecord.request': 'CHATS_FETCH' },
		defineSnapshot({
			result: TelegramOpcode.CHATS_FETCH_RESULT,
			partSchema: TelegramChatsPart,
			parts: () => snapshotParts(client, filter),
		}),
	);
}
