import type { TelegramClient } from '@mtcute/node';

import type { ChatList } from '@telecord/producer-core/config';

import { SNAPSHOT_MAX_PEERS } from './snapshot';
import { subjectOfRaw } from './peers';

/**
 * Every chat of the saved session, archived ones included, with the `peerId`
 * and `peerType` filter rules match it by.
 *
 * @param client - The session, not yet connected.
 * @returns The chats, in dialog order.
 * @throws When no session is saved, or the account has more chats than a snapshot may name.
 */
async function listTelegramChats(client: TelegramClient): Promise<ChatList> {
	await client.prepare();

	if (!(await client.storage.self.fetch())) {
		throw new Error(
			'No Telegram session is saved: log in first with docker compose run --rm telegram login',
		);
	}

	const chats: ChatList['chats'] = [];

	for await (const { peer } of client.iterDialogs({ archived: 'keep' })) {
		const { peerId, peerType } = subjectOfRaw(peer.raw);

		if (peerId === undefined || peerType === undefined) {
			continue;
		}

		if (chats.length === SNAPSHOT_MAX_PEERS) {
			throw new Error(`The account has more than ${SNAPSHOT_MAX_PEERS} chats`);
		}

		chats.push({ id: peerId, name: peer.displayName, type: peerType });
	}

	return { platform: 'telegram', chats };
}

export default listTelegramChats;
