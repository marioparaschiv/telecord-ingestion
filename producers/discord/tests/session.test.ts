import { afterAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { DiscordChatsPart, DiscordIdentify, DiscordOpcode } from '@telecord/ingest-client/discord';
import { IngestOpcode, SessionState } from '@telecord/ingest-client';
import { Outbox } from '@telecord/producer-core';

import {
	CLIENT_BUILD,
	GENERAL_CHANNEL_ID,
	GUILD_ID,
	SELF,
	startDiscord,
	vector,
	type DiscordHarness,
} from './fixtures';
import { FakeDiscordGateway } from './fake-gateway';
import { loadSession } from '../src/session';

// The client takes its timers from `node:timers` and `node:timers/promises` as it loads, out of
// reach of fake timers. Until the file ends those delegate to the globals, which a test can fake.
const restoreTimers = await vi.hoisted(async () => {
	const { default: timers } = await import('node:timers');
	const { default: promises } = await import('node:timers/promises');
	const { setTimeout, clearTimeout, setInterval, clearInterval } = timers;
	const originalSleep = promises.setTimeout;

	timers.setTimeout = ((...args: Parameters<typeof setTimeout>) =>
		globalThis.setTimeout(...args)) as typeof timers.setTimeout;
	timers.clearTimeout = (timeout) => globalThis.clearTimeout(timeout);
	timers.setInterval = ((...args: Parameters<typeof setInterval>) =>
		globalThis.setInterval(...args)) as typeof timers.setInterval;
	timers.clearInterval = (interval) => globalThis.clearInterval(interval);
	promises.setTimeout = (async (delay?: number, value?: unknown) =>
		new Promise((resolve) =>
			globalThis.setTimeout(resolve, delay, value),
		)) as typeof promises.setTimeout;

	return () => {
		Object.assign(timers, { setTimeout, clearTimeout, setInterval, clearInterval });
		promises.setTimeout = originalSleep;
	};
});

afterAll(restoreTimers);

const TOKEN = 'test.token.value';

/** A guild text channel created after the stored `READY`. */
const CREATED_CHANNEL = {
	id: '1100000000000000004',
	type: 0,
	guild_id: GUILD_ID,
	name: 'announcements',
	position: 3,
	permission_overwrites: [],
	last_message_id: null,
};

let gateway: FakeDiscordGateway;
let outboxPath: string;
/** The run still going when the test ends. */
let running: DiscordHarness | undefined;

beforeEach(async () => {
	const directory = mkdtempSync(join(tmpdir(), 'discord-producer-'));

	gateway = await FakeDiscordGateway.start();
	outboxPath = join(directory, 'outbox.sqlite');

	return async () => {
		await running?.close();
		running = undefined;
		await gateway.close();
		rmSync(directory, { recursive: true, force: true });
	};
});

function message(id?: string): object {
	const created = vector('event/message-create');
	const payload = z.looseObject({}).parse(created.kind === 'event' ? created.send.d : undefined);

	return id === undefined ? payload : { ...payload, id };
}

/** Starts a run on the shared gateway and outbox, announcing the guild in `READY` as Discord does. */
async function run(): Promise<DiscordHarness> {
	running = await startDiscord(undefined, { gateway, outboxPath, guildInReady: true });

	return running;
}

/**
 * Starts a run, running the client's clock until it identifies: the network is
 * real, so each step first lets pending socket I/O through.
 */
async function runIdentifyingLater(): Promise<DiscordHarness> {
	const identified = gateway.identified;
	const harness = run();

	while (gateway.identified === identified) {
		await new Promise((resolve) => setImmediate(resolve));
		await vi.advanceTimersByTimeAsync(100);
	}

	return harness;
}

/** A first run that creates a channel and forwards one message, then shuts down the way the producer does. */
async function runAndStop(): Promise<DiscordHarness> {
	const harness = await startDiscord(undefined, { gateway, outboxPath, guildInReady: true });

	harness.gateway.dispatch('CHANNEL_CREATE', CREATED_CHANNEL);
	harness.gateway.dispatch('MESSAGE_CREATE', message());
	await harness.socket.nextFrame();
	await harness.socket.nextFrame();
	await harness.close();

	return harness;
}

function storedSession() {
	const outbox = new Outbox(outboxPath);

	try {
		return loadSession(outbox);
	} finally {
		outbox.close();
	}
}

function identified(harness: DiscordHarness) {
	return DiscordIdentify.parse(harness.identify.d);
}

async function snapshotChannels(harness: DiscordHarness): Promise<string[]> {
	harness.socket.send(DiscordOpcode.CHATS_FETCH, {}, 'snapshot');

	const channels: string[] = [];

	for (;;) {
		const part = DiscordChatsPart.parse((await harness.socket.nextFrame()).d);

		channels.push(...part.guilds.flatMap(({ channels: guild }) => guild.map(({ id }) => id)));

		if (part.done) {
			return channels;
		}
	}
}

describe('gateway session', () => {
	it('closes the gateway with a code that keeps the session resumable on shutdown', async () => {
		const { gateway: session } = await runAndStop();

		expect(await session.closed).toBe(4000);
	});

	it('keeps the session, its READY, the dispatches that changed the cache and the last sequence in the outbox', async () => {
		const { gateway: session } = await runAndStop();

		// READY, the channel, then the message.
		expect(storedSession()).toMatchObject({
			sessionId: session.id,
			resumeURL: gateway.url,
			sequence: 3,
			ready: { session_id: session.id, user: SELF },
			dispatches: [
				{ t: 'CHANNEL_CREATE', d: CREATED_CHANNEL },
				{ t: 'MESSAGE_CREATE', d: message() },
			],
		});
	});

	it('keeps only the newest message of each channel', async () => {
		const harness = await run();
		const newest = message('1100000000000000997');

		harness.gateway.dispatch('MESSAGE_CREATE', message());
		harness.gateway.dispatch('MESSAGE_CREATE', newest);
		await harness.socket.nextFrame();
		await harness.socket.nextFrame();

		expect(storedSession()?.dispatches).toEqual([{ t: 'MESSAGE_CREATE', d: newest }]);
	});

	it('leaves resumed out of IDENTIFY when no session is stored', async () => {
		const harness = await run();

		expect(gateway.resumes).toEqual([]);
		expect(identified(harness)).not.toHaveProperty('resumed');
	});

	it("resumes the previous run's session with its cache after a restart", async () => {
		const { gateway: previous } = await runAndStop();
		const missed = message('1100000000000000998');

		gateway.answerResume = {
			outcome: 'resumed',
			dispatches: [{ event: 'MESSAGE_CREATE', payload: missed }],
		};

		const harness = await run();

		expect(gateway.resumes).toEqual([{ token: TOKEN, session_id: previous.id, seq: 3 }]);
		expect(identified(harness)).toMatchObject({ id: SELF.id, resumed: true });
		// The first run's events were never acknowledged, so they are sent again ahead of the replay.
		expect(harness.backlog.map(({ op, d }) => ({ op, d }))).toEqual([
			{ op: 'CHANNEL_CREATE', d: CREATED_CHANNEL },
			{ op: 'MESSAGE_CREATE', d: message() },
			{ op: 'MESSAGE_CREATE', d: missed },
		]);
		expect(await snapshotChannels(harness)).toEqual(
			expect.arrayContaining([GENERAL_CHANNEL_ID, CREATED_CHANNEL.id]),
		);
		// The replay and RESUMED follow the stored sequence.
		expect(storedSession()).toMatchObject({ sessionId: previous.id, sequence: 5 });
	});

	it('identifies to Discord invisible and away, as the desktop client with its real builds', async () => {
		const harness = await run();

		expect(harness.gateway.identify).toMatchObject({
			presence: { status: 'invisible', afk: true },
			properties: {
				os: 'Windows',
				browser: 'Discord Client',
				release_channel: 'stable',
				client_version: CLIENT_BUILD.clientVersion,
				client_build_number: CLIENT_BUILD.clientBuildNumber,
				native_build_number: CLIENT_BUILD.nativeBuildNumber,
			},
		});
		await vi.waitFor(() =>
			expect(harness.gateway.presences).toContainEqual(
				expect.objectContaining({ status: 'invisible', afk: true }),
			),
		);
	});

	it('goes invisible again after resuming a session stored while online', async () => {
		await runAndStop();

		gateway.answerResume = { outcome: 'resumed', dispatches: [] };

		const harness = await run();

		expect(harness.gateway.resumed).toBe(true);
		await vi.waitFor(() =>
			expect(harness.gateway.presences).toContainEqual(
				expect.objectContaining({ status: 'invisible', afk: true }),
			),
		);
	});

	it('identifies anew when Discord invalidates the session, and tells the server it did not resume', async () => {
		vi.useFakeTimers({
			toFake: ['setTimeout', 'clearTimeout', 'setInterval', 'clearInterval'],
		});
		onTestFinished(() => {
			vi.useRealTimers();
		});

		const { gateway: previous } = await runAndStop();

		gateway.answerResume = { outcome: 'invalid' };

		const harness = await runIdentifyingLater();

		expect(gateway.resumes).toHaveLength(1);
		expect(harness.gateway.id).not.toBe(previous.id);
		expect(identified(harness).resumed).toBe(false);
		expect(harness.backlog.map(({ op }) => op)).toEqual(['CHANNEL_CREATE', 'MESSAGE_CREATE']);
		// The new READY does not hold the channel, so the seeded one is gone.
		expect(await snapshotChannels(harness)).not.toContain(CREATED_CHANNEL.id);
		expect(storedSession()).toMatchObject({ sessionId: harness.gateway.id, dispatches: [] });
	});
});

describe('session state', () => {
	it('reports ready once READY answers IDENTIFY', async () => {
		const harness = await run();

		expect(harness.sessionState).toEqual({
			op: IngestOpcode.SESSION_STATE,
			d: { state: SessionState.READY },
		});
	});

	it('reports a token Discord closes the gateway over as invalid_credentials', async () => {
		const harness = await run();

		harness.gateway.close(4004, 'Authentication failed.');

		expect(await harness.socket.nextFrame()).toEqual({
			op: IngestOpcode.SESSION_STATE,
			d: { state: SessionState.INVALID_CREDENTIALS, reason: '4004 Authentication failed.' },
		});
	});

	it('reports reconnecting while the client resumes a dropped gateway session, then ready', async () => {
		const harness = await run();

		gateway.answerResume = { outcome: 'resumed', dispatches: [] };
		harness.gateway.close(4000, 'Unknown error');

		expect(await harness.socket.nextFrame()).toEqual({
			op: IngestOpcode.SESSION_STATE,
			d: { state: SessionState.RECONNECTING },
		});
		expect(await harness.socket.nextFrame()).toEqual({
			op: IngestOpcode.SESSION_STATE,
			d: { state: SessionState.READY },
		});
		expect(gateway.resumes).toEqual([{ token: TOKEN, session_id: harness.gateway.id, seq: 1 }]);
	});
});
