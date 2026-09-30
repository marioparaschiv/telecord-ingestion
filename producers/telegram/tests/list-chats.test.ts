import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TelegramClient, tl } from '@mtcute/node';

import { ChatListSchema } from '@telecord/producer-core/config';

import { SELF, createOfflineClient, dialogOf, iterate, vectorChats } from './fixtures';
import { SNAPSHOT_MAX_PEERS } from '../src/snapshot';
import listTelegramChats from '../src/list-chats';

const FRIEND: tl.RawUser = { _: 'user', id: 777_000_222, firstName: 'Grace', lastName: 'Hopper' };

let client: TelegramClient;

beforeEach(async () => {
	client = await createOfflineClient();
});

afterEach(async () => {
	await client.destroy();
});

async function logIn(): Promise<void> {
	await client.storage.self.store({
		userId: SELF.id,
		isBot: false,
		isPremium: false,
		usernames: [],
	});
}

describe('listTelegramChats', () => {
	it('lists every dialog by the peerId and peerType filter rules match', async () => {
		const { forum, group } = vectorChats();
		const iterDialogs = vi
			.spyOn(client, 'iterDialogs')
			.mockReturnValue(
				iterate([
					dialogOf({ _: 'peerChannel', channelId: forum.id }, [forum]),
					dialogOf({ _: 'peerChat', chatId: group.id }, [group]),
					dialogOf({ _: 'peerUser', userId: FRIEND.id }, [], [FRIEND]),
				]),
			);

		await logIn();

		const list = await listTelegramChats(client);

		expect(ChatListSchema.parse(list)).toEqual(list);
		expect(list).toEqual({
			platform: 'telegram',
			chats: [
				{ id: `-100${forum.id}`, name: forum.title, type: 'group' },
				{ id: `-${group.id}`, name: group.title, type: 'group' },
				{ id: String(FRIEND.id), name: 'Grace Hopper', type: 'user' },
			],
		});
		expect(iterDialogs).toHaveBeenCalledWith({ archived: 'keep' });
	});

	it('points to login when no session is saved', async () => {
		const iterDialogs = vi.spyOn(client, 'iterDialogs');

		await expect(listTelegramChats(client)).rejects.toThrow(
			'No Telegram session is saved: log in first with docker compose run --rm telegram login',
		);
		expect(iterDialogs).not.toHaveBeenCalled();
	});

	it('refuses an account with more chats than a snapshot may name', async () => {
		const dialog = dialogOf({ _: 'peerUser', userId: FRIEND.id }, [], [FRIEND]);

		vi.spyOn(client, 'iterDialogs').mockReturnValue(
			iterate(Array.from({ length: SNAPSHOT_MAX_PEERS + 1 }, () => dialog)),
		);
		await logIn();

		await expect(listTelegramChats(client)).rejects.toThrow(
			`The account has more than ${SNAPSHOT_MAX_PEERS} chats`,
		);
	});
});
