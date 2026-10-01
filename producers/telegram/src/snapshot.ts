import { parseMarkedPeerId, type Dialog, type TelegramClient, type tl } from '@mtcute/node';

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

import type ChatStore from './chats';

import {
	fetchChat,
	fetchFullChat,
	fetchFullUser,
	isComplete,
	markedIdOf,
	subjectOfMarkedId,
	subjectOfRaw,
} from './peers';
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
 *
 * @param client - The session.
 * @param peer - The forum.
 * @returns The pages, in order.
 */
export async function forumTopicPages(
	client: TelegramClient,
	peer: tl.TypeInputPeer,
): Promise<tl.messages.RawForumTopics[]> {
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
	if (!forum.accessHash) {
		return [];
	}

	try {
		return await forumTopicPages(client, {
			_: 'inputPeerChannel',
			channelId: forum.id,
			accessHash: forum.accessHash,
		});
	} catch (error) {
		logger.warn(`Failed to fetch the topics of forum ${forum.id}: ${asError(error).message}`);

		return [];
	}
}

/** Whether a chat shows the account still in it: not left, not forbidden. */
function isReachable(chat: tl.TypeChat): boolean {
	return (chat._ === 'chat' || chat._ === 'channel') && !chat.left;
}

/**
 * The chats the last snapshot named that its dialog walk missed, as Telegram has them now, when
 * the account can still read them. Dialogs page by last message date, so a chat that gets a
 * message mid-walk can jump past the cursor, and the busiest chats are the likeliest to.
 */
async function* recheckMissing(
	client: TelegramClient,
	filter: Filter,
	missing: Iterable<number>,
): AsyncGenerator<tl.TypeChat> {
	for (const markedId of missing) {
		try {
			const chat = await fetchChat(client, markedId);

			if (chat && isReachable(chat) && isAllowed(filter, subjectOfRaw(chat))) {
				logger.info(
					`Kept chat ${markedId}, which the dialog walk missed but is still readable`,
				);

				yield chat;
			}
		} catch (error) {
			logger.warn(
				`Failed to re-check chat ${markedId}, leaving it out: ${asError(error).message}`,
			);
		}
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

type SnapshotChat = { raw: Dialog['peer']['raw'] | tl.TypeChat; topMessage?: TopMessage };

/** A learned chat as Telegram has it now, or undefined when the bot can no longer reach it. */
async function fetchLearned(
	client: TelegramClient,
	peerId: number,
): Promise<tl.RawUser | tl.TypeChat | undefined> {
	const [kind, id] = parseMarkedPeerId(peerId);

	if (kind === 'user') {
		const user = await fetchFullUser(client, id);

		return user?._ === 'user' ? user : undefined;
	}

	const chat = await fetchChat(client, peerId);

	return chat && isReachable(chat) ? chat : undefined;
}

/**
 * Each chat a bot learned, as Telegram has it now, with the newest message seen in it. A chat
 * the bot can no longer reach is forgotten.
 */
async function* learnedChats(
	client: TelegramClient,
	filter: Filter,
	learned: ChatStore,
): AsyncGenerator<SnapshotChat> {
	for (const { peerId, topMessage } of learned.all()) {
		const [kind] = parseMarkedPeerId(peerId);

		// A user or basic group is typed by its id alone, so a blocked one is never fetched.
		if (kind !== 'channel' && !isAllowed(filter, await subjectOfMarkedId(client, peerId))) {
			continue;
		}

		let raw: Awaited<ReturnType<typeof fetchLearned>>;

		try {
			raw = await fetchLearned(client, peerId);
		} catch (error) {
			logger.warn(
				`Failed to fetch chat ${peerId}, leaving it out: ${asError(error).message}`,
			);

			continue;
		}

		if (!raw) {
			logger.info(`Forgot chat ${peerId}, which the bot can no longer reach`);
			learned.forget(peerId);

			continue;
		}

		if (isAllowed(filter, subjectOfRaw(raw))) {
			yield {
				raw,
				topMessage:
					topMessage > 0 ? { peerId: String(peerId), messageId: topMessage } : undefined,
			};
		}
	}
}

/**
 * Each chat the dialog walk lists, and then each one the re-check keeps, with its newest message.
 * A bot has no dialogs to walk, so its learned chats are listed instead.
 */
async function* snapshotChats(
	client: TelegramClient,
	filter: Filter,
	named: Set<number>,
	lastNamed: ReadonlySet<number>,
	learned?: ChatStore,
): AsyncGenerator<SnapshotChat> {
	if (learned) {
		yield* learnedChats(client, filter, learned);

		return;
	}

	for await (const dialog of client.iterDialogs({ archived: 'keep' })) {
		const { peer } = dialog;

		if (isAllowed(filter, subjectOfRaw(peer.raw))) {
			named.add(peer.id);

			yield { raw: peer.raw, topMessage: topMessageOf(dialog) };
		}
	}

	const missing = [...lastNamed].filter((markedId) => !named.has(markedId));

	for await (const chat of recheckMissing(client, filter, missing)) {
		const markedId = markedIdOf(chat);

		if (markedId !== undefined) {
			named.add(markedId);
		}

		yield { raw: chat };
	}
}

/**
 * The account's chats as snapshot parts, walked from its dialogs: each forum
 * in a part of its own with its topic pages, every other chat and private
 * chat counterpart batched up to the per-part cap. Each part names the newest
 * message of its chats. Chats the filter rules block are left out.
 *
 * A group or channel the last completed snapshot named that the walk misses is
 * re-checked with Telegram and kept when the account can still read it. A
 * private chat is never revoked by the server, so it is not re-checked.
 *
 * Forums are walked one after another, since Telegram flood-limits bursts of
 * topic requests, and each part is yielded as soon as it is complete.
 *
 * A bot's parts are built from its learned chats. It cannot list a forum's
 * topics, so its forums are batched with its other chats and carry no pages.
 */
async function* snapshotParts(
	client: TelegramClient,
	filter: Filter,
	lastNamed: ReadonlySet<number>,
	named: Set<number>,
	learned?: ChatStore,
): AsyncGenerator<TelegramChatsPartFields> {
	let chats: tl.TypeChat[] = [];
	let users: tl.TypeUser[] = [];
	let topMessages: TopMessage[] = [];
	let peerCount = 0;
	let topicCount = 0;

	for await (const { raw, topMessage } of snapshotChats(
		client,
		filter,
		named,
		lastNamed,
		learned,
	)) {
		if (++peerCount > SNAPSHOT_MAX_PEERS) {
			throw new Error(`The account has more than ${SNAPSHOT_MAX_PEERS} chats`);
		}

		if (raw._ === 'user') {
			users.push(raw);
		} else {
			const chat = await completeChat(client, raw);

			if (chat._ === 'channel' && chat.forum && !learned) {
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
 * @param learned - The chats a bot learned, which stand in for the dialogs Telegram never lists it.
 * @returns The handler.
 */
export function createTelegramSnapshot(
	client: TelegramClient,
	filter: Filter,
	learned?: ChatStore,
): RequestHandler {
	/** The groups and channels, by marked id, the last snapshot to run to its end named. */
	let lastNamed: ReadonlySet<number> = new Set();

	async function* parts(): AsyncGenerator<TelegramChatsPartFields> {
		const named = new Set<number>();

		yield* snapshotParts(client, filter, lastNamed, named, learned);

		lastNamed = new Set([...named].filter((markedId) => markedId < 0));
	}

	return traceRequest(
		'telegram.chats_fetch',
		{ 'telecord.platform': 'telegram', 'telecord.request': 'CHATS_FETCH' },
		defineSnapshot({
			result: TelegramOpcode.CHATS_FETCH_RESULT,
			partSchema: TelegramChatsPart,
			parts,
		}),
	);
}
