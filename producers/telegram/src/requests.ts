import {
	isInputPeerChannel,
	isInputPeerUser,
	toInputChannel,
	toInputUser,
} from '@mtcute/node/utils.js';
import { Long, MtTimeoutError, getMarkedPeerId, tl, type TelegramClient } from '@mtcute/node';
import { open, rm } from 'node:fs/promises';
import { openAsBlob } from 'node:fs';
import { join } from 'node:path';

import {
	TelegramCustomEmojisFetch,
	TelegramCustomEmojisFetchResult,
	TelegramForumTopicsFetch,
	TelegramForumTopicsFetchResult,
	TelegramMediaFetch,
	TelegramMediaFetchResult,
	TelegramMessagesFetch,
	TelegramMessagesFetchResult,
	TelegramOpcode,
	TelegramUsersFetch,
	TelegramUsersFetchResult,
	type TelegramCustomEmojisFetchPayload,
	type TelegramCustomEmojisFetchResultPayload,
	type TelegramForumTopicsFetchPayload,
	type TelegramForumTopicsFetchResultPayload,
	type TelegramMediaFetchPayload,
	type TelegramMediaFetchResultPayload,
	type TelegramMessagesFetchPayload,
	type TelegramMessagesFetchResultPayload,
	type TelegramUsersFetchPayload,
	type TelegramUsersFetchResultPayload,
} from '@telecord/ingest-client/telegram';
import {
	asError,
	createTaggedLogger,
	defineProbe,
	defineRequest,
	failureMessage,
	isAllowed,
	postPresigned,
	type Filter,
	type ProgressReporter,
	type RequestHandler,
} from '@telecord/producer-core';
import { recordError, withSpan } from '@telecord/producer-otel';
import { RequestFailureReason } from '@telecord/ingest-client';

import type ChatStore from './chats';

import { decodeFileLocation, serialize, serializeVector, type FileLocation } from './tl';
import { resolveInputPeer, subjectOfMarkedId } from './peers';
import { forumTopicPages } from './snapshot';

/** Errors meaning this session can no longer read the chat. */
const ACCESS_ERRORS = new Set<string>([
	'CHANNEL_PRIVATE',
	'CHANNEL_INVALID',
	'CHAT_FORBIDDEN',
	'CHAT_ID_INVALID',
	'PEER_ID_INVALID',
	'USER_BANNED_IN_CHANNEL',
]);

const FILE_REFERENCE_ERRORS = new Set<string>(['FILE_REFERENCE_EXPIRED', 'FILE_REFERENCE_INVALID']);

/** The server waits 10 minutes for `MESSAGES_FETCH`, so flood waits up to 9 are slept through. */
const MESSAGES_FETCH_FLOOD_SLEEP = 9 * 60_000;

/**
 * mtcute retries a failing `upload.getFile` forever, so a file Telegram keeps answering with
 * `-503 Timeout` would download for good. A stalled download is resumed from where it stopped.
 */
const DOWNLOAD_STALL_TIMEOUT = 40_000;

/**
 * Stalls in a row a download resumes from before it gives up. The server fails a `MEDIA_FETCH` two
 * minutes after its last progress, sent at most `PROGRESS_INTERVAL` before a stall begins, so the
 * last stall still ends in an answer the server is waiting for.
 */
const DOWNLOAD_STALL_RETRIES = 1;

/** How often a download that is receiving bytes reports its progress. */
const PROGRESS_INTERVAL = 15_000;

/** The most message ids one `getMessages` call reads. */
const ID_WALK_WINDOW = 100;

/** The most windows one range `MESSAGES_FETCH` reads, so a sparse range still ends in an answer. */
const ID_WALK_MAX_WINDOWS = 50;

/** The most topic pages one `FORUM_TOPICS_FETCH_RESULT` carries. */
const FORUM_TOPICS_MAX_PAGES = 1_000;

const logger = createTaggedLogger('Telegram Requests');

type DownloadTarget = { location: FileLocation; dcId: number };

type MessageSource = Extract<TelegramMediaFetchPayload['source'], { kind: 'message' }>;

function isAccessError(error: unknown): boolean {
	return tl.RpcError.is(error) && ACCESS_ERRORS.has(error.text);
}

function isFileReferenceError(error: unknown): boolean {
	return tl.RpcError.is(error) && FILE_REFERENCE_ERRORS.has(error.text);
}

/** Where a download is written and how its progress is reported. */
type DownloadSink = {
	/** The file the bytes are written to, replaced on every attempt. */
	path: string;
	progress: ProgressReporter;
};

async function isChatAllowed(
	client: TelegramClient,
	filter: Filter,
	markedId: number,
): Promise<boolean> {
	return isAllowed(filter, await subjectOfMarkedId(client, markedId));
}

function readMessagesById(
	client: TelegramClient,
	peer: tl.TypeInputPeer,
	ids: readonly number[],
): Promise<tl.messages.TypeMessages> {
	const options = { floodSleepThreshold: MESSAGES_FETCH_FLOOD_SLEEP };
	const id = ids.map((messageId): tl.TypeInputMessage => ({
		_: 'inputMessageID',
		id: messageId,
	}));

	// Channel message ids are per channel, so they are read through the channel itself.
	return isInputPeerChannel(peer)
		? client.call({ _: 'channels.getMessages', channel: toInputChannel(peer), id }, options)
		: client.call({ _: 'messages.getMessages', id }, options);
}

type MessagesRange = Exclude<TelegramMessagesFetchPayload, { ids: number[] }>;

/**
 * One page of a chat's history for a bot, which Telegram refuses `messages.getHistory`. The ids
 * of the range are read window by window, upwards for a page after an id alone and downwards
 * otherwise, until the page is full or the range is spent.
 *
 * Outside channels message ids are shared by every chat of the account, so a
 * window also returns other chats' messages, which are dropped. The walk ends
 * at `ID_WALK_MAX_WINDOWS`, which leaves the page short.
 *
 * @param client - The bot's session.
 * @param peer - The chat.
 * @param markedId - The chat's marked id.
 * @param range - The page asked for.
 * @param top - The id of the newest message seen in the chat, which no id of the page is past.
 * @returns The page as `messages.getHistory` orders it, newest first.
 */
async function walkMessages(
	client: TelegramClient,
	peer: tl.TypeInputPeer,
	markedId: number,
	{ before, after = 0, limit }: MessagesRange,
	top: number,
): Promise<tl.messages.RawMessages> {
	const ascending = before === undefined && after > 0;
	const messages: tl.TypeMessage[] = [];
	const topics = new Map<number, tl.TypeForumTopic>();
	const chats = new Map<number, tl.TypeChat>();
	const users = new Map<number, tl.TypeUser>();
	let low = after + 1;
	let high = before === undefined ? top : Math.min(top, before - 1);

	for (let window = 0; low <= high && messages.length < limit; window++) {
		if (window === ID_WALK_MAX_WINDOWS) {
			logger.warn(
				`Stopped reading ${markedId} after ${window * ID_WALK_WINDOW} ids, with ${low} to ${high} unread`,
			);

			break;
		}

		const size = Math.min(ID_WALK_WINDOW, high - low + 1);
		const first = ascending ? low : high - size + 1;
		const page = await readMessagesById(
			client,
			peer,
			Array.from({ length: size }, (_, index) => first + index),
		);

		if (ascending) {
			low += size;
		} else {
			high -= size;
		}

		if (page._ === 'messages.messagesNotModified') {
			continue;
		}

		const found = page.messages
			.filter(
				(message) =>
					message._ !== 'messageEmpty' && getMarkedPeerId(message.peerId) === markedId,
			)
			.toSorted((a, b) => (ascending ? a.id - b.id : b.id - a.id));

		messages.push(...found.slice(0, limit - messages.length));

		for (const topic of page.topics) {
			topics.set(topic.id, topic);
		}

		for (const chat of page.chats) {
			chats.set(chat.id, chat);
		}

		for (const user of page.users) {
			users.set(user.id, user);
		}
	}

	return {
		_: 'messages.messages',
		messages: messages.toSorted((a, b) => b.id - a.id),
		topics: [...topics.values()],
		chats: [...chats.values()],
		users: [...users.values()],
	};
}

async function readMessages(
	client: TelegramClient,
	peer: tl.TypeInputPeer,
	markedId: number,
	request: TelegramMessagesFetchPayload,
	learned?: ChatStore,
): Promise<tl.messages.TypeMessages> {
	if ('ids' in request) {
		return readMessagesById(client, peer, request.ids);
	}

	if (learned) {
		return walkMessages(client, peer, markedId, request, learned.topMessage(markedId) ?? 0);
	}

	const { before, after, limit } = request;

	// A page after an id alone is read upwards from it: a negative offset returns the newer messages.
	return client.call(
		{
			_: 'messages.getHistory',
			peer,
			offsetId: before ?? after ?? 0,
			offsetDate: 0,
			addOffset: before === undefined && after !== undefined ? -limit : 0,
			limit,
			maxId: 0,
			minId: after ?? 0,
			hash: Long.ZERO,
		},
		{ floodSleepThreshold: MESSAGES_FETCH_FLOOD_SLEEP },
	);
}

/**
 * Answers one `MESSAGES_FETCH` with the boxed `messages.Messages` Telegram
 * returned. A blocked chat is declined before anything calls Telegram, and a
 * peer the session's cache lacks is resolved through Telegram. A bot reads a
 * page of history by walking its ids.
 */
async function fetchMessages(
	client: TelegramClient,
	filter: Filter,
	request: TelegramMessagesFetchPayload,
	learned?: ChatStore,
): Promise<TelegramMessagesFetchResultPayload> {
	const markedId = Number(request.peerId);

	if (!(await isChatAllowed(client, filter, markedId))) {
		return { ok: false, reason: RequestFailureReason.FILTERED };
	}

	try {
		const peer = await resolveInputPeer(client, markedId);

		if (!peer) {
			return {
				ok: false,
				reason: RequestFailureReason.ACCESS_LOST,
				message: `Chat ${request.peerId} cannot be resolved by this session`,
			};
		}

		return {
			ok: true,
			messages: serialize(await readMessages(client, peer, markedId, request, learned)),
		};
	} catch (error) {
		logger.warn(`Failed to fetch messages in ${request.peerId}: ${asError(error).message}`);
		recordError(error);

		return isAccessError(error)
			? {
					ok: false,
					reason: RequestFailureReason.ACCESS_LOST,
					message: failureMessage(error),
				}
			: { ok: false, message: failureMessage(error) };
	}
}

/**
 * Answers one `USERS_FETCH` with the boxed `Vector<User>` `users.getUsers`
 * returned: the server asks because the user just changed, so the session's
 * cached copy is not the answer. A user is no chat, so no filter applies.
 */
async function fetchUsers(
	client: TelegramClient,
	{ userId }: TelegramUsersFetchPayload,
): Promise<TelegramUsersFetchResultPayload> {
	try {
		const peer = await resolveInputPeer(client, userId);

		if (!peer || !isInputPeerUser(peer)) {
			return { ok: false, reason: RequestFailureReason.ACCESS_LOST };
		}

		const users = await client.call({ _: 'users.getUsers', id: [toInputUser(peer)] });

		return { ok: true, users: serializeVector(users) };
	} catch (error) {
		logger.warn(`Failed to fetch user ${userId}: ${asError(error).message}`);
		recordError(error);

		return isAccessError(error)
			? {
					ok: false,
					reason: RequestFailureReason.ACCESS_LOST,
					message: failureMessage(error),
				}
			: { ok: false, message: failureMessage(error) };
	}
}

/** The documents behind custom emoji, as `messages.getCustomEmojiDocuments` returns them. */
function customEmojiDocuments(
	client: TelegramClient,
	documentIds: string[],
): Promise<tl.TypeDocument[]> {
	return client.call({
		_: 'messages.getCustomEmojiDocuments',
		documentId: documentIds.map((documentId) => Long.fromString(documentId)),
	});
}

/**
 * Answers one `CUSTOM_EMOJIS_FETCH` with the boxed `Vector<Document>` Telegram
 * returned. An emoji document is no chat, so no filter applies.
 */
async function fetchCustomEmojis(
	client: TelegramClient,
	{ documentIds }: TelegramCustomEmojisFetchPayload,
): Promise<TelegramCustomEmojisFetchResultPayload> {
	try {
		return {
			ok: true,
			documents: serializeVector(await customEmojiDocuments(client, documentIds)),
		};
	} catch (error) {
		logger.warn(
			`Failed to fetch ${documentIds.length} custom emoji: ${asError(error).message}`,
		);
		recordError(error);

		return { ok: false, message: failureMessage(error) };
	}
}

/**
 * Answers one `FORUM_TOPICS_FETCH` with every `messages.forumTopics` page of the
 * forum, paged as a chat snapshot pages them. A blocked forum is declined before
 * anything calls Telegram.
 */
async function fetchForumTopics(
	client: TelegramClient,
	filter: Filter,
	{ peerId }: TelegramForumTopicsFetchPayload,
): Promise<TelegramForumTopicsFetchResultPayload> {
	const markedId = Number(peerId);

	if (!(await isChatAllowed(client, filter, markedId))) {
		return { ok: false, reason: RequestFailureReason.FILTERED };
	}

	try {
		const peer = await resolveInputPeer(client, markedId);

		if (!peer) {
			return {
				ok: false,
				reason: RequestFailureReason.ACCESS_LOST,
				message: `Forum ${peerId} cannot be resolved by this session`,
			};
		}

		const pages = await forumTopicPages(client, peer);

		if (pages.length > FORUM_TOPICS_MAX_PAGES) {
			return {
				ok: false,
				message: `Forum ${peerId} has more than ${FORUM_TOPICS_MAX_PAGES} topic pages`,
			};
		}

		return { ok: true, topics: pages.map((page) => serialize(page)) };
	} catch (error) {
		logger.warn(`Failed to fetch the topics of forum ${peerId}: ${asError(error).message}`);
		recordError(error);

		return isAccessError(error)
			? {
					ok: false,
					reason: RequestFailureReason.ACCESS_LOST,
					message: failureMessage(error),
				}
			: { ok: false, message: failureMessage(error) };
	}
}

/**
 * The chat whose photo a peer photo location reads, when it names one. A
 * user's photo names no chat, so no filter applies, as with `USERS_FETCH`.
 */
function photoChatId(location: FileLocation): number | undefined {
	if (location._ !== 'inputPeerPhotoFileLocation') {
		return undefined;
	}

	const { peer } = location;

	return isInputPeerUser(peer) || peer._ === 'inputPeerEmpty' ? undefined : getMarkedPeerId(peer);
}

async function locate(
	client: TelegramClient,
	filter: Filter,
	locator: TelegramMediaFetchPayload['locator'],
): Promise<DownloadTarget | TelegramMediaFetchResultPayload> {
	if (locator.kind === 'tl') {
		const location = decodeFileLocation(locator.location);

		if (!location) {
			return { ok: false, reason: RequestFailureReason.UNSUPPORTED_LOCATION };
		}

		const chatId = photoChatId(location);

		if (chatId !== undefined && !(await isChatAllowed(client, filter, chatId))) {
			return { ok: false, reason: RequestFailureReason.FILTERED };
		}

		return { location, dcId: locator.dcId };
	}

	const [document] = await customEmojiDocuments(client, [locator.documentId]);

	if (document?._ !== 'document') {
		return { ok: false, reason: RequestFailureReason.SOURCE_DELETED };
	}

	return {
		location: {
			_: 'inputDocumentFileLocation',
			id: document.id,
			accessHash: document.accessHash,
			fileReference: document.fileReference,
			thumbSize: '',
		},
		dcId: document.dcId,
	};
}

/** The photos and documents a message carries, including its link preview's. */
function filesOf(message: tl.TypeMessage): (tl.RawPhoto | tl.RawDocument)[] {
	if (message._ !== 'message' || !message.media) {
		return [];
	}

	const { media } = message;

	switch (media._) {
		case 'messageMediaPhoto':
			return media.photo?._ === 'photo' ? [media.photo] : [];

		case 'messageMediaDocument':
			return media.document?._ === 'document' ? [media.document] : [];

		case 'messageMediaWebPage': {
			if (media.webpage._ !== 'webPage') {
				return [];
			}

			const { photo, document } = media.webpage;

			return [
				...(photo?._ === 'photo' ? [photo] : []),
				...(document?._ === 'document' ? [document] : []),
			];
		}

		default:
			return [];
	}
}

/**
 * Refetches the message a file hangs off and swaps its fresh file reference
 * into the expired location.
 */
async function refreshReference(
	client: TelegramClient,
	{ location, dcId }: DownloadTarget,
	source: MessageSource,
): Promise<DownloadTarget | TelegramMediaFetchResultPayload> {
	if (location._ === 'inputPeerPhotoFileLocation') {
		return { ok: false, reason: RequestFailureReason.EXPIRED };
	}

	const peer = await resolveInputPeer(client, Number(source.peerId));

	if (!peer) {
		return { ok: false, reason: RequestFailureReason.SOURCE_CONTEXT_LOST };
	}

	const refetched = await readMessagesById(client, peer, [source.messageId]);
	const message =
		refetched._ === 'messages.messagesNotModified'
			? undefined
			: refetched.messages.find((candidate) => candidate.id === source.messageId);
	const kind = location._ === 'inputPhotoFileLocation' ? 'photo' : 'document';
	const file = message
		? filesOf(message).find((entry) => entry._ === kind && entry.id.eq(location.id))
		: undefined;

	if (!file) {
		return {
			ok: false,
			reason: RequestFailureReason.SOURCE_DELETED,
			message: `Message ${source.messageId} in ${source.peerId} no longer carries the file`,
		};
	}

	return { location: { ...location, fileReference: file.fileReference }, dcId };
}

/**
 * Streams the file to disk, so memory does not grow with its size. A stall is resumed from the
 * offset reached, and progress is reported while bytes arrive, never while stalled.
 *
 * @returns How many bytes were written, or undefined once the file grows past `maxBytes`.
 */
async function download(
	client: TelegramClient,
	{ location, dcId }: DownloadTarget,
	maxBytes: number,
	{ path, progress }: DownloadSink,
): Promise<number | undefined> {
	const file = await open(path, 'w');
	let offset = 0;
	let stalls = 0;
	let reportedAt = Date.now();

	try {
		for (;;) {
			try {
				const chunks = client.downloadAsIterable(location, {
					dcId,
					offset,
					stallTimeout: DOWNLOAD_STALL_TIMEOUT,
				});

				for await (const chunk of chunks) {
					offset += chunk.byteLength;

					if (offset > maxBytes) {
						return undefined;
					}

					await file.write(chunk);
					stalls = 0;

					if (Date.now() - reportedAt >= PROGRESS_INTERVAL) {
						progress(offset);
						reportedAt = Date.now();
					}
				}

				return offset;
			} catch (error) {
				if (!(error instanceof MtTimeoutError) || stalls >= DOWNLOAD_STALL_RETRIES) {
					throw error;
				}

				stalls += 1;
				logger.warn(`Download stalled at ${offset} bytes, resuming from there`);
			}
		}
	} finally {
		await file.close();
	}
}

/**
 * Downloads the file, refreshing an expired file reference through its source
 * message and retrying once. An avatar has no message to refresh through.
 */
async function downloadRefreshing(
	client: TelegramClient,
	target: DownloadTarget,
	{ source, maxBytes }: TelegramMediaFetchPayload,
	sink: DownloadSink,
): Promise<number | undefined | TelegramMediaFetchResultPayload> {
	try {
		return await download(client, target, maxBytes, sink);
	} catch (error) {
		if (!isFileReferenceError(error)) {
			throw error;
		}

		if (source.kind === 'avatar') {
			return { ok: false, reason: RequestFailureReason.EXPIRED };
		}

		const refreshed = await refreshReference(client, target, source);

		return 'location' in refreshed ? download(client, refreshed, maxBytes, sink) : refreshed;
	}
}

function mediaSourceOf({ source }: TelegramMediaFetchPayload): string {
	return source.kind === 'message'
		? `message ${source.messageId} in ${source.peerId}`
		: 'an avatar';
}

/**
 * Answers one `MEDIA_FETCH`: downloads the file from the session to disk and posts it
 * to the presigned upload. The source chat is checked against the filter
 * rules, and the locator against the three allowed locations, before Telegram
 * is called.
 */
async function fetchMedia(
	client: TelegramClient,
	filter: Filter,
	downloadDir: string,
	request: TelegramMediaFetchPayload,
	progress: ProgressReporter,
): Promise<TelegramMediaFetchResultPayload> {
	const { locator, source, maxBytes, upload } = request;

	if (
		source.kind === 'message' &&
		!(await isChatAllowed(client, filter, Number(source.peerId)))
	) {
		return { ok: false, reason: RequestFailureReason.FILTERED };
	}

	const path = join(downloadDir, `${crypto.randomUUID()}.part`);

	try {
		const target = await locate(client, filter, locator);

		if (!('location' in target)) {
			return target;
		}

		const bytes = await downloadRefreshing(client, target, request, { path, progress });

		if (bytes === undefined) {
			return { ok: false, message: `The file is larger than ${maxBytes} bytes` };
		}

		if (typeof bytes !== 'number') {
			return bytes;
		}

		const status = await postPresigned(upload, await openAsBlob(path));

		return status >= 200 && status < 300
			? { ok: true, bytes }
			: { ok: false, message: `The upload was answered with HTTP ${status}` };
	} catch (error) {
		logger.warn(
			`Failed to fetch media for ${mediaSourceOf(request)}: ${asError(error).message}`,
		);
		recordError(error);

		return isAccessError(error)
			? {
					ok: false,
					reason: RequestFailureReason.ACCESS_LOST,
					message: failureMessage(error),
				}
			: { ok: false, message: failureMessage(error) };
	} finally {
		await rm(path, { force: true });
	}
}

/**
 * The single-result requests a Telegram producer answers: `PROBE`,
 * `MESSAGES_FETCH`, `MEDIA_FETCH` and `USERS_FETCH`, and the optional
 * `CUSTOM_EMOJIS_FETCH` and `FORUM_TOPICS_FETCH` it declares, each chat-scoped
 * one checked against the filter rules.
 *
 * @param client - The logged-in session.
 * @param filter - The producer's filter rules.
 * @param downloadDir - Where `MEDIA_FETCH` writes a file while it downloads.
 * @param learned - The chats a bot learned, whose newest message bounds a page of history.
 * @returns The handlers, keyed by request opcode.
 */
export function createTelegramRequests(
	client: TelegramClient,
	filter: Filter,
	downloadDir: string,
	learned?: ChatStore,
): Record<string, RequestHandler> {
	return {
		[TelegramOpcode.PROBE]: defineProbe(TelegramOpcode.PROBE_RESULT),
		[TelegramOpcode.MESSAGES_FETCH]: defineRequest({
			payload: TelegramMessagesFetch,
			result: TelegramOpcode.MESSAGES_FETCH_RESULT,
			resultSchema: TelegramMessagesFetchResult,
			handle: (request) =>
				withSpan(
					'telegram.messages_fetch',
					{
						'telecord.platform': 'telegram',
						'telecord.request': 'MESSAGES_FETCH',
						'telegram.chat.id': request.peerId,
						'telegram.message.ids': 'ids' in request ? request.ids : undefined,
					},
					() => fetchMessages(client, filter, request, learned),
				),
		}),
		[TelegramOpcode.MEDIA_FETCH]: defineRequest({
			payload: TelegramMediaFetch,
			result: TelegramOpcode.MEDIA_FETCH_RESULT,
			resultSchema: TelegramMediaFetchResult,
			handle: (request, progress) =>
				withSpan(
					'telegram.media_fetch',
					{
						'telecord.platform': 'telegram',
						'telecord.request': 'MEDIA_FETCH',
						'telegram.media.source': request.source.kind,
						'telegram.media.locator': request.locator.kind,
						...(request.source.kind === 'message' && {
							'telegram.chat.id': request.source.peerId,
							'telegram.message.id': request.source.messageId,
						}),
					},
					() => fetchMedia(client, filter, downloadDir, request, progress),
				),
		}),
		[TelegramOpcode.USERS_FETCH]: defineRequest({
			payload: TelegramUsersFetch,
			result: TelegramOpcode.USERS_FETCH_RESULT,
			resultSchema: TelegramUsersFetchResult,
			handle: (request) =>
				withSpan(
					'telegram.users_fetch',
					{
						'telecord.platform': 'telegram',
						'telecord.request': 'USERS_FETCH',
						'telegram.user.id': request.userId,
					},
					() => fetchUsers(client, request),
				),
		}),
		[TelegramOpcode.CUSTOM_EMOJIS_FETCH]: defineRequest({
			payload: TelegramCustomEmojisFetch,
			result: TelegramOpcode.CUSTOM_EMOJIS_FETCH_RESULT,
			resultSchema: TelegramCustomEmojisFetchResult,
			handle: (request) =>
				withSpan(
					'telegram.custom_emojis_fetch',
					{
						'telecord.platform': 'telegram',
						'telecord.request': 'CUSTOM_EMOJIS_FETCH',
						'telegram.document.count': request.documentIds.length,
					},
					() => fetchCustomEmojis(client, request),
				),
		}),
		[TelegramOpcode.FORUM_TOPICS_FETCH]: defineRequest({
			payload: TelegramForumTopicsFetch,
			result: TelegramOpcode.FORUM_TOPICS_FETCH_RESULT,
			resultSchema: TelegramForumTopicsFetchResult,
			handle: (request) =>
				withSpan(
					'telegram.forum_topics_fetch',
					{
						'telecord.platform': 'telegram',
						'telecord.request': 'FORUM_TOPICS_FETCH',
						'telegram.chat.id': request.peerId,
					},
					() => fetchForumTopics(client, filter, request),
				),
		}),
	};
}
