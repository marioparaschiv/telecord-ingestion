import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readStringSession } from '@mtcute/node/utils.js';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { TelegramClient } from '@mtcute/node';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import createTelegramClient, { SESSION_FILE } from '../src/client';
import { vectorUpdates } from './fixtures';

const SELF = { userId: 777000999, isBot: false, isPremium: false, usernames: [] };
const AUTH_KEY = new Uint8Array(256).fill(7);
const CHANNEL_MARKED_ID = -1001987654321;

let dataDir: string;
const clients: TelegramClient[] = [];

async function open(): Promise<TelegramClient> {
	const client = createTelegramClient({ apiId: 1, apiHash: 'offline', dataDir });

	clients.push(client);
	await client.prepare();

	return client;
}

/** Shuts a client down the way the producer does on exit, flushing the session to disk. */
async function close(client: TelegramClient): Promise<void> {
	clients.splice(clients.indexOf(client), 1);
	await client.destroy();
}

beforeEach(async () => {
	dataDir = await mkdtemp(join(tmpdir(), 'telegram-producer-'));
});

afterEach(async () => {
	for (const client of clients.splice(0)) {
		await client.destroy();
	}

	await rm(dataDir, { recursive: true, force: true });
});

describe('the Telegram session', () => {
	it('lives in DATA_DIR and survives a restart with its login, peer cache and update state', async () => {
		const before = await open();

		await before.importSession({ authKey: AUTH_KEY, self: SELF });
		await before.storage.peers.updatePeersFrom(vectorUpdates());
		await before.storage.updates.setPts(5_001);
		await before.storage.updates.setQts(12);
		await before.storage.updates.setDate(1_758_000_000);
		await before.storage.updates.setSeq(3);
		await before.storage.updates.setChannelPts(1_987_654_321, 5_001);
		await close(before);

		expect(await readdir(dataDir)).toContain(SESSION_FILE);

		const after = await open();
		const restored = readStringSession(await after.exportSession());

		expect(restored.authKey).toEqual(AUTH_KEY);
		expect(await after.storage.self.fetch()).toEqual(SELF);
		expect(await after.storage.peers.getById(CHANNEL_MARKED_ID)).toMatchObject({
			_: 'inputPeerChannel',
			channelId: 1_987_654_321,
		});
		expect(await after.storage.peers.getCompleteById(CHANNEL_MARKED_ID)).toMatchObject({
			_: 'channel',
			title: 'Engine Room',
			min: false,
		});
		expect(await after.storage.updates.getState()).toEqual([5_001, 12, 1_758_000_000, 3]);
		expect(await after.storage.updates.getChannelPts(1_987_654_321)).toBe(5_001);
	});
});
