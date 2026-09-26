import {
	getMarkedPeerId,
	parseMarkedPeerId,
	type PeersIndex,
	type TelegramClient,
	type tl,
} from '@mtcute/node';
import { toInputChannel } from '@mtcute/node/utils.js';

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

	const [kind, id] = parseMarkedPeerId(markedId);

	if (kind === 'chat') {
		const { chats } = await client.call({ _: 'messages.getChats', id: [id] });

		return chats.find((chat) => chat.id === id);
	}

	if (kind !== 'channel') {
		return undefined;
	}

	const input = await client.storage.peers.getById(markedId);

	if (!input) {
		return undefined;
	}

	const { chats } = await client.call({ _: 'channels.getChannels', id: [toInputChannel(input)] });

	return chats.find((chat) => chat.id === id);
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
