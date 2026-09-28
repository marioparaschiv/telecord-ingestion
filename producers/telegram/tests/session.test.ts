import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { readStringSession } from '@mtcute/node/utils.js';
import { mkdtemp, readdir, rm } from 'node:fs/promises';
import type { TelegramClient } from '@mtcute/node';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { IngestOpcode, SessionState } from '@telecord/ingest-client';

import { SELF as ACCOUNT, startHarness, vectorUpdates, type Harness } from './fixtures';
import createTelegramClient, { SESSION_FILE } from '../src/client';
import { watchCalls } from '../src/session';

const SELF = { userId: 777000999, isBot: false, isPremium: false, usernames: [] };
const AUTH_KEY = new Uint8Array(256).fill(7);
const CHANNEL_MARKED_ID = -1001987654321;

let dataDir: string;
const clients: TelegramClient[] = [];

async function open(): Promise<TelegramClient> {
	const client = createTelegramClient({
		apiId: 1,
		apiHash: 'offline',
		dataDir,
		onUnauthorized: vi.fn(),
		onUpdatesSkipped: vi.fn(),
	});

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

describe('watchCalls', () => {
	const onUnauthorized = vi.fn<(reason: string) => void>();
	const onUpdatesSkipped = vi.fn<(reason: string) => void>();
	const watch = watchCalls({ onUnauthorized, onUpdatesSkipped });
	const getDifference = {
		request: { _: 'updates.getDifference', pts: 5_001, date: 1_758_000_000, qts: 12 },
	} as const;

	afterEach(() => {
		onUnauthorized.mockClear();
		onUpdatesSkipped.mockClear();
	});

	it.each(['AUTH_KEY_UNREGISTERED', 'SESSION_REVOKED', 'USER_DEACTIVATED_BAN'])(
		'reports a 401 %s as a refused authorization and passes it on',
		async (errorMessage) => {
			const error = { _: 'mt_rpc_error', errorCode: 401, errorMessage };

			await expect(watch(getDifference, async () => error)).resolves.toBe(error);
			expect(onUnauthorized).toHaveBeenCalledWith(errorMessage);
			expect(onUpdatesSkipped).not.toHaveBeenCalled();
		},
	);

	it('leaves other errors alone', async () => {
		await watch(getDifference, async () => ({
			_: 'mt_rpc_error',
			errorCode: 420,
			errorMessage: 'FLOOD_WAIT_3',
		}));

		expect(onUnauthorized).not.toHaveBeenCalled();
		expect(onUpdatesSkipped).not.toHaveBeenCalled();
	});

	it.each([
		[getDifference, { _: 'updates.differenceTooLong', pts: 9_000 }],
		[
			{
				request: {
					_: 'updates.getChannelDifference',
					channel: { _: 'inputChannelEmpty' },
					filter: { _: 'channelMessagesFilterEmpty' },
					pts: 5_001,
					limit: 100,
				},
			},
			{ _: 'updates.channelDifferenceTooLong', messages: [] },
		],
		[{ request: { _: 'updates.getState' } }, { _: 'updates.state', pts: 9_000 }],
	] as const)('reports skipped updates when %j answers %j', async (context, result) => {
		await watch(context, async () => result);

		expect(onUpdatesSkipped).toHaveBeenCalledOnce();
	});

	it('reports nothing for a difference it can replay', async () => {
		await watch(getDifference, async () => ({ _: 'updates.differenceEmpty', date: 0, seq: 3 }));

		expect(onUpdatesSkipped).not.toHaveBeenCalled();
	});
});

describe('the session monitor', () => {
	let harness: Harness;

	beforeEach(async () => {
		harness = await startHarness();

		return () => harness.close();
	});

	function sessionState(state: SessionState, reason?: string) {
		return { op: 'SESSION_STATE', d: { state, ...(reason !== undefined && { reason }) } };
	}

	/** The frames the producer sent up to the `PONG` answering a `PING` sent now. */
	async function framesSent() {
		const frames = [];

		harness.socket.send(IngestOpcode.PING);

		for (let frame = await harness.socket.nextFrame(); frame.op !== IngestOpcode.PONG;) {
			frames.push(frame);
			frame = await harness.socket.nextFrame();
		}

		return frames;
	}

	it('reports a dropped connection as reconnecting until mtcute is connected again', async () => {
		const { onConnectionState } = harness.client;

		await framesSent();
		onConnectionState.emit('connected');
		onConnectionState.emit('connecting');
		onConnectionState.emit('offline');
		onConnectionState.emit('updating');
		onConnectionState.emit('connected');

		expect(await framesSent()).toEqual([
			sessionState(SessionState.READY),
			sessionState(SessionState.RECONNECTING),
			sessionState(SessionState.READY),
		]);
	});

	it('holds invalid_credentials through reconnects until a login starts the updates loop', async () => {
		const { client, producer } = harness;

		await framesSent();
		client.onConnectionState.emit('connected');
		producer.session.onUnauthorized('AUTH_KEY_UNREGISTERED');
		client.onConnectionState.emit('connecting');
		client.onConnectionState.emit('connected');

		expect(await framesSent()).toEqual([
			sessionState(SessionState.READY),
			sessionState(SessionState.INVALID_CREDENTIALS, 'AUTH_KEY_UNREGISTERED'),
		]);

		client.onConnectionState.emit('updating');

		expect(await framesSent()).toEqual([sessionState(SessionState.READY)]);
	});

	it('settles caughtUp once the catch-up a login starts has ended', async () => {
		const { client, producer } = harness;
		let settled = false;

		client.onConnectionState.emit('updating');

		const caughtUp = producer.session.caughtUp().then(() => {
			settled = true;
		});

		client.onConnectionState.emit('connecting');
		await new Promise((resolve) => setImmediate(resolve));

		expect(settled).toBe(false);

		client.onConnectionState.emit('connected');
		await caughtUp;

		await expect(producer.session.caughtUp()).resolves.toBeUndefined();
	});

	it('settles caughtUp once Telegram refuses the authorization during the catch-up', async () => {
		const { client, producer } = harness;

		client.onConnectionState.emit('updating');

		const caughtUp = producer.session.caughtUp();

		producer.session.onUnauthorized('AUTH_KEY_UNREGISTERED');

		await expect(caughtUp).resolves.toBeUndefined();
	});

	it('identifies as before and repeats invalid_credentials after a reconnect once the authorization is gone', async () => {
		const { client, producer, server, socket } = harness;

		await framesSent();
		producer.session.onUnauthorized('AUTH_KEY_UNREGISTERED');

		expect(await framesSent()).toEqual([
			sessionState(SessionState.INVALID_CREDENTIALS, 'AUTH_KEY_UNREGISTERED'),
		]);

		vi.spyOn(client, 'getMe').mockRejectedValue(new Error('AUTH_KEY_UNREGISTERED'));
		vi.useFakeTimers({ toFake: ['setTimeout'] });
		socket.terminate();

		for (let step = 0; step < 100 && server.pendingConnections.length === 0; step++) {
			await vi.advanceTimersByTimeAsync(100);
			await new Promise((resolve) => setImmediate(resolve));
		}

		vi.useRealTimers();

		const resumed = await server.nextConnection();

		resumed.hello();

		expect((await resumed.ready()).d).toMatchObject({ id: ACCOUNT.id, recovered: true });
		expect(await resumed.nextFrame()).toEqual(
			sessionState(SessionState.INVALID_CREDENTIALS, 'AUTH_KEY_UNREGISTERED'),
		);
	});
});
