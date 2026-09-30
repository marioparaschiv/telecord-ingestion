import {
	Long,
	MtPeerNotFoundError,
	getMarkedPeerId,
	parseMarkedPeerId,
	type PeersIndex,
	type TelegramClient,
	type tl,
} from '@mtcute/node';
import { toInputChannel, toInputUser } from '@mtcute/node/utils.js';

import type { PeerType, TelegramFilterSubject } from './filter';

/** The raw users and chats a session caches and ships. */
export type RawPeer = tl.TypeUser | tl.TypeChat;

/**
 * The peer type the filter rules see for a raw user or chat.
 *
 * @param raw - The user or chat.
 * @returns Its type, or undefined for a constructor that is no conversation (a community).
 */
export function peerTypeOf(raw: RawPeer): PeerType | undefined {
	switch (raw._) {
		case 'user':
		case 'userEmpty':
			return 'user';

		case 'chat':
		case 'chatEmpty':
		case 'chatForbidden':
			return 'group';

		case 'channel':
		case 'channelForbidden':
			return raw.broadcast ? 'channel' : 'group';

		default:
			return undefined;
	}
}

/**
 * The marked id of a raw user or chat, read off the constructor since a min
 * chat has no access hash to build a peer from.
 *
 * @param raw - The user or chat.
 * @returns The marked id, or undefined for a constructor that is no conversation.
 */
export function markedIdOf(raw: RawPeer): number | undefined {
	switch (raw._) {
		case 'user':
		case 'userEmpty':
			return raw.id;

		case 'chat':
		case 'chatEmpty':
		case 'chatForbidden':
			return getMarkedPeerId(raw.id, 'chat');

		case 'channel':
		case 'channelForbidden':
			return getMarkedPeerId(raw.id, 'channel');

		default:
			return undefined;
	}
}

export function isChat(raw: RawPeer): raw is tl.TypeChat {
	return raw._ !== 'user' && raw._ !== 'userEmpty';
}

/** Whether a cached or shipped copy is complete, rather than a min copy seen through someone else. */
export function isComplete(raw: RawPeer): boolean {
	return !('min' in raw && raw.min);
}

/**
 * The filter subject of a raw user or chat, as a snapshot or request sees it.
 *
 * @param raw - The user or chat.
 * @returns Its subject.
 */
export function subjectOfRaw(raw: RawPeer): TelegramFilterSubject {
	const markedId = markedIdOf(raw);

	return {
		peerType: peerTypeOf(raw),
		peerId: markedId === undefined ? undefined : String(markedId),
	};
}

/**
 * The filter subject of a marked peer id. A user or basic group is typed by the
 * id alone; a channel needs a copy to tell a broadcast from a supergroup, taken
 * from the peers that came with an update or from the session's cache, so this
 * never calls Telegram.
 *
 * @param client - The session.
 * @param markedId - The peer's marked id.
 * @param peers - The peers that came with the update, if any.
 * @returns The subject, without a type when the session knows no copy of the channel.
 */
export async function subjectOfMarkedId(
	client: TelegramClient,
	markedId: number,
	peers?: PeersIndex,
): Promise<TelegramFilterSubject> {
	const peerId = String(markedId);
	const [kind, id] = parseMarkedPeerId(markedId);

	if (kind === 'user') {
		return { peerType: 'user', peerId };
	}

	if (kind === 'chat') {
		return { peerType: 'group', peerId };
	}

	const known = peers?.chats.get(id) ?? (await client.storage.peers.getCompleteById(markedId));

	return { peerType: known ? peerTypeOf(known) : undefined, peerId };
}

/**
 * Resolves a marked peer id to an input peer the way mtcute does: from the session's cache,
 * including a min peer through a message it was seen in, then through its username or phone, then
 * from Telegram itself.
 *
 * @param client - The session.
 * @param markedId - The peer's marked id.
 * @returns The input peer, or undefined when neither the cache nor Telegram can address it.
 */
export async function resolveInputPeer(
	client: TelegramClient,
	markedId: number,
): Promise<tl.TypeInputPeer | undefined> {
	try {
		return await client.resolvePeer(markedId);
	} catch (error) {
		if (error instanceof MtPeerNotFoundError) {
			return undefined;
		}

		throw error;
	}
}

/**
 * The session's full, non-min copy of a basic group or channel, fetched from
 * Telegram when the cache holds none or only a min copy.
 *
 * @param client - The session.
 * @param markedId - The chat's marked id.
 * @returns The chat, or undefined when the session cannot address it.
 */
export async function fetchFullChat(
	client: TelegramClient,
	markedId: number,
): Promise<tl.TypeChat | undefined> {
	const cached = await client.storage.peers.getCompleteById(markedId);

	if (cached && isChat(cached) && isComplete(cached)) {
		return cached;
	}

	return fetchChat(client, markedId);
}

/**
 * A basic group or channel as Telegram has it now, fetched even when the cache holds a copy.
 *
 * @param client - The session.
 * @param markedId - The chat's marked id.
 * @returns The chat, or undefined when the session cannot address it.
 */
export async function fetchChat(
	client: TelegramClient,
	markedId: number,
): Promise<tl.TypeChat | undefined> {
	const [kind, id] = parseMarkedPeerId(markedId);

	if (kind === 'chat') {
		const { chats } = await client.call({ _: 'messages.getChats', id: [id] });

		return chats.find((chat) => chat.id === id);
	}

	if (kind !== 'channel') {
		return undefined;
	}

	const input = await resolveInputPeer(client, markedId);

	if (!input) {
		return undefined;
	}

	const { chats } = await client.call({ _: 'channels.getChannels', id: [toInputChannel(input)] });

	return chats.find((chat) => chat.id === id);
}

/**
 * The forbidden constructor Telegram itself answers with for a chat the session lost access to,
 * carrying whatever access hash, title and kind the session held for it.
 *
 * @param markedId - The marked id of a basic group or channel.
 * @param held - The session's last copy of the chat, if any.
 * @returns `chatForbidden` for a basic group, `channelForbidden` for a channel or supergroup.
 */
export function forbiddenChatOf(
	markedId: number,
	held?: tl.TypeChat,
): tl.RawChatForbidden | tl.RawChannelForbidden {
	const [kind, id] = parseMarkedPeerId(markedId);
	const title = (held && 'title' in held ? held.title : undefined) ?? '';

	if (kind === 'chat') {
		return { _: 'chatForbidden', id, title };
	}

	if (kind !== 'channel') {
		throw new TypeError(`Expected a basic group or channel, got ${markedId}`);
	}

	return {
		_: 'channelForbidden',
		id,
		accessHash: (held && 'accessHash' in held ? held.accessHash : undefined) ?? Long.ZERO,
		title,
		broadcast: held && 'broadcast' in held ? held.broadcast : undefined,
		megagroup: held && 'megagroup' in held ? held.megagroup : undefined,
	};
}

/**
 * The session's complete, non-min copy of a user, fetched from Telegram when
 * the cache holds none or only a min copy.
 *
 * @param client - The session.
 * @param userId - The user's id.
 * @returns The user, or undefined when the session cannot address them.
 */
export async function fetchFullUser(
	client: TelegramClient,
	userId: number,
): Promise<tl.TypeUser | undefined> {
	const cached = await client.storage.peers.getCompleteById(userId);

	if (cached?._ === 'user' && isComplete(cached)) {
		return cached;
	}

	const input = await resolveInputPeer(client, userId);

	if (!input) {
		return undefined;
	}

	const users = await client.call({ _: 'users.getUsers', id: [toInputUser(input)] });

	return users.find((user) => user.id === userId);
}

/**
 * Swaps every min user and chat an update carries for the session's complete
 * copy, where it holds one.
 *
 * @param client - The session.
 * @param peers - The update's peers, replaced in place.
 */
export async function replaceMinPeers(client: TelegramClient, peers: PeersIndex): Promise<void> {
	await Promise.all([
		...[...peers.users].map(async ([id, user]) => {
			const complete = isComplete(user)
				? undefined
				: await client.storage.peers.getCompleteById(id);

			if (complete?._ === 'user') {
				peers.users.set(id, complete);
			}
		}),
		...[...peers.chats].map(async ([id, chat]) => {
			const markedId = markedIdOf(chat);
			const complete =
				isComplete(chat) || markedId === undefined
					? undefined
					: await client.storage.peers.getCompleteById(markedId);

			if (complete && isChat(complete)) {
				peers.chats.set(id, complete);
			}
		}),
	]);
}
