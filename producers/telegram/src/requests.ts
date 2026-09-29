import {
	isInputPeerChannel,
	isInputPeerUser,
	toInputChannel,
	toInputUser,
} from '@mtcute/node/utils.js';
import { Long, getMarkedPeerId, tl, type TelegramClient } from '@mtcute/node';

import {
	TelegramMediaFetch,
	TelegramMediaFetchResult,
	TelegramMessagesFetch,
	TelegramMessagesFetchResult,
	TelegramOpcode,
	TelegramUsersFetch,
	TelegramUsersFetchResult,
	type TelegramMediaFetchPayload,
	type TelegramMediaFetchResultPayload,
	type TelegramMessagesFetchPayload,
	type TelegramMessagesFetchResultPayload,
	type TelegramUsersFetchPayload,
	type TelegramUsersFetchResultPayload,
} from '@telecord/ingest-client/telegram';
import {
	defineProbe,
	defineRequest,
	failureMessage,
	isAllowed,
	postPresigned,
	readLimited,
	type Filter,
	type RequestHandler,
} from '@telecord/producer-core';
import { RequestFailureReason } from '@telecord/ingest-client';

import { decodeFileLocation, serialize, serializeVector, type FileLocation } from './tl';
import { subjectOfMarkedId } from './peers';

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
 * `-503 Timeout` would download for good. The server gives up on `MEDIA_FETCH` after 2 minutes.
 */
const DOWNLOAD_STALL_TIMEOUT = 60_000;

type DownloadTarget = { location: FileLocation; dcId: number };

type MessageSource = Extract<TelegramMediaFetchPayload['source'], { kind: 'message' }>;

function isAccessError(error: unknown): boolean {
	return tl.RpcError.is(error) && ACCESS_ERRORS.has(error.text);
}

function isFileReferenceError(error: unknown): boolean {
	return tl.RpcError.is(error) && FILE_REFERENCE_ERRORS.has(error.text);
}

async function isChatAllowed(
	client: TelegramClient,
	filter: Filter,
	markedId: number,
): Promise<boolean> {
	return isAllowed(filter, await subjectOfMarkedId(client, markedId));
}

async function readMessages(
	client: TelegramClient,
	peer: tl.TypeInputPeer,
	request: TelegramMessagesFetchPayload,
): Promise<tl.messages.TypeMessages> {
	const options = { floodSleepThreshold: MESSAGES_FETCH_FLOOD_SLEEP };

	if ('ids' in request) {
		const id = request.ids.map((messageId): tl.TypeInputMessage => ({
			_: 'inputMessageID',
			id: messageId,
		}));

		// Channel message ids are per channel, so they are read through the channel itself.
		return isInputPeerChannel(peer)
			? client.call({ _: 'channels.getMessages', channel: toInputChannel(peer), id }, options)
			: client.call({ _: 'messages.getMessages', id }, options);
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
		options,
	);
}

/**
 * Answers one `MESSAGES_FETCH` with the boxed `messages.Messages` Telegram
 * returned. A blocked chat is declined before anything else, and the peer is
 * resolved from the session's own cache, so neither calls Telegram.
 */
async function fetchMessages(
	client: TelegramClient,
	filter: Filter,
	request: TelegramMessagesFetchPayload,
): Promise<TelegramMessagesFetchResultPayload> {
	const markedId = Number(request.peerId);

	if (!(await isChatAllowed(client, filter, markedId))) {
		return { ok: false, reason: RequestFailureReason.FILTERED };
	}

	const peer = await client.storage.peers.getById(markedId);

	if (!peer) {
		return {
			ok: false,
			reason: RequestFailureReason.ACCESS_LOST,
			message: `Chat ${request.peerId} is unknown to this session`,
		};
	}

	try {
		return { ok: true, messages: serialize(await readMessages(client, peer, request)) };
	} catch (error) {
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
	const peer = await client.storage.peers.getById(userId);

	if (!peer || !isInputPeerUser(peer)) {
		return { ok: false, reason: RequestFailureReason.ACCESS_LOST };
	}

	try {
		const users = await client.call({ _: 'users.getUsers', id: [toInputUser(peer)] });

		return { ok: true, users: serializeVector(users) };
	} catch (error) {
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

	const [document] = await client.call({
		_: 'messages.getCustomEmojiDocuments',
		documentId: [Long.fromString(locator.documentId)],
	});

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

	const peer = await client.storage.peers.getById(Number(source.peerId));

	if (!peer) {
		return { ok: false, reason: RequestFailureReason.SOURCE_CONTEXT_LOST };
	}

	const refetched = await readMessages(client, peer, {
		peerId: source.peerId,
		ids: [source.messageId],
	});
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

function download(
	client: TelegramClient,
	{ location, dcId }: DownloadTarget,
	maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
	return readLimited(
		client.downloadAsIterable(location, { dcId, stallTimeout: DOWNLOAD_STALL_TIMEOUT }),
		maxBytes,
	);
}

/**
 * Downloads the file, refreshing an expired file reference through its source
 * message and retrying once. An avatar has no message to refresh through.
 */
async function downloadRefreshing(
	client: TelegramClient,
	target: DownloadTarget,
	{ source, maxBytes }: TelegramMediaFetchPayload,
): Promise<Uint8Array<ArrayBuffer> | undefined | TelegramMediaFetchResultPayload> {
	try {
		return await download(client, target, maxBytes);
	} catch (error) {
		if (!isFileReferenceError(error)) {
			throw error;
		}

		if (source.kind === 'avatar') {
			return { ok: false, reason: RequestFailureReason.EXPIRED };
		}

		const refreshed = await refreshReference(client, target, source);

		return 'location' in refreshed ? download(client, refreshed, maxBytes) : refreshed;
	}
}

/**
 * Answers one `MEDIA_FETCH`: downloads the file from the session and posts it
 * to the presigned upload. The source chat is checked against the filter
 * rules, and the locator against the three allowed locations, before Telegram
 * is called.
 */
async function fetchMedia(
	client: TelegramClient,
	filter: Filter,
	request: TelegramMediaFetchPayload,
): Promise<TelegramMediaFetchResultPayload> {
	const { locator, source, maxBytes, upload } = request;

	if (
		source.kind === 'message' &&
		!(await isChatAllowed(client, filter, Number(source.peerId)))
	) {
		return { ok: false, reason: RequestFailureReason.FILTERED };
	}

	try {
		const target = await locate(client, filter, locator);

		if (!('location' in target)) {
			return target;
		}

		const bytes = await downloadRefreshing(client, target, request);

		if (bytes === undefined) {
			return { ok: false, message: `The file is larger than ${maxBytes} bytes` };
		}

		if (!(bytes instanceof Uint8Array)) {
			return bytes;
		}

		const status = await postPresigned(upload, bytes);

		return status >= 200 && status < 300
			? { ok: true, bytes: bytes.byteLength }
			: { ok: false, message: `The upload was answered with HTTP ${status}` };
	} catch (error) {
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
 * The single-result requests a Telegram producer answers: `PROBE`,
 * `MESSAGES_FETCH`, `MEDIA_FETCH` and `USERS_FETCH`, each chat-scoped one
 * checked against the filter rules.
 *
 * @param client - The logged-in session.
 * @param filter - The producer's filter rules.
 * @returns The handlers, keyed by request opcode.
 */
export function createTelegramRequests(
	client: TelegramClient,
	filter: Filter,
): Record<string, RequestHandler> {
	return {
		[TelegramOpcode.PROBE]: defineProbe(TelegramOpcode.PROBE_RESULT),
		[TelegramOpcode.MESSAGES_FETCH]: defineRequest({
			payload: TelegramMessagesFetch,
			result: TelegramOpcode.MESSAGES_FETCH_RESULT,
			resultSchema: TelegramMessagesFetchResult,
			handle: (request) => fetchMessages(client, filter, request),
		}),
		[TelegramOpcode.MEDIA_FETCH]: defineRequest({
			payload: TelegramMediaFetch,
			result: TelegramOpcode.MEDIA_FETCH_RESULT,
			resultSchema: TelegramMediaFetchResult,
			handle: (request) => fetchMedia(client, filter, request),
		}),
		[TelegramOpcode.USERS_FETCH]: defineRequest({
			payload: TelegramUsersFetch,
			result: TelegramOpcode.USERS_FETCH_RESULT,
			resultSchema: TelegramUsersFetchResult,
			handle: (request) => fetchUsers(client, request),
		}),
	};
}
