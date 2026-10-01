import { Chat, User, type TelegramClient } from '@mtcute/node';

import type { ChatList } from '@telecord/producer-core/config';

import type ChatStore from './chats';

import { isChat, subjectOfRaw, type RawPeer } from './peers';
import { SNAPSHOT_MAX_PEERS } from './snapshot';

/** Each chat of the session: its dialogs, or for a bot the learned chats its cache holds a copy of. */
async function* sessionPeers(client: TelegramClient, learned?: ChatStore): AsyncGenerator<RawPeer> {
	if (!learned) {
		for await (const { peer } of client.iterDialogs({ archived: 'keep' })) {
			yield peer.raw;
		}

		return;
	}

	for (const { peerId } of learned.all()) {
		const raw = await client.storage.peers.getCompleteById(peerId);

		if (raw) {
			yield raw;
		}
	}
}

/**
 * Every chat of the saved session, archived ones included, with the `peerId`
 * and `peerType` filter rules match it by.
 *
 * @param client - The session, not yet connected.
 * @param learned - The chats a bot learned, which stand in for the dialogs Telegram never lists it.
 * @returns The chats, in dialog order.
 * @throws When no session is saved, or the account has more chats than a snapshot may name.
 */
async function listTelegramChats(client: TelegramClient, learned?: ChatStore): Promise<ChatList> {
	await client.prepare();

	if (!(await client.storage.self.fetch())) {
		throw new Error(
			'No Telegram session is saved: log in first with docker compose run --rm telegram login',
		);
	}

	const chats: ChatList['chats'] = [];

	for await (const raw of sessionPeers(client, learned)) {
		const { peerId, peerType } = subjectOfRaw(raw);

		if (peerId === undefined || peerType === undefined) {
			continue;
		}

		if (chats.length === SNAPSHOT_MAX_PEERS) {
			throw new Error(`The account has more than ${SNAPSHOT_MAX_PEERS} chats`);
		}

		const { displayName } = isChat(raw) ? new Chat(raw) : new User(raw);

		chats.push({ id: peerId, name: displayName, type: peerType });
	}

	return { platform: 'telegram', chats };
}

export default listTelegramChats;
