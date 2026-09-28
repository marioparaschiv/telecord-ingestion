import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import {
	IngestErrorCode,
	IngestOpcode,
	IngestProbeResultSchema,
	IngestProbeSchema,
	type IngestEnvelope,
} from '@telecord/ingest-client';
import { TelegramChatsPart, TelegramOpcode } from '@telecord/ingest-client/telegram';

import { FakeIngestServer, type FakeProducerSocket } from '../src/testing';
import { defineRequest, defineSnapshot } from '../src/requests';
import IngestConnection from '../src/connection';
import Outbox from '../src/outbox';

type ConnectOptions = {
	requests?: ConstructorParameters<typeof IngestConnection>[0]['requests'];
	outbox?: Outbox;
	window?: number;
};

const IDENTITY = { _: 'user', id: 7, self: true };

let server: FakeIngestServer;
let connection: IngestConnection | undefined;
let outbox: Outbox;
const onFatal = vi.fn<(reason: string) => void>();

function connect({ requests = {}, outbox: stream, window = 500 }: ConnectOptions = {}) {
	connection?.stop();
	outbox = stream ?? new Outbox(':memory:');
	connection = new IngestConnection({
		url: server.url,
		apiKey: 'tc_key',
		route: '/telegram/v1',
		versionParam: 'layer',
		version: 229,
		outbox,
		window,
		identify: async () => IDENTITY,
		requests,
		onFatal,
	});
	connection.start();

	return connection;
}

/** A connection greeted with `HELLO` and answered with `READY`. */
async function streaming(lastSeq = 0): Promise<FakeProducerSocket> {
	const socket = await server.nextConnection();

	socket.hello();
	await socket.ready(lastSeq);

	return socket;
}

/**
 * The producer's next connection, letting fake time run in small steps until
 * its reconnect timer fires, with the event loop turning in between so the
 * real sockets make progress.
 */
async function reconnected(): Promise<FakeProducerSocket> {
	for (let step = 0; step < 600 && server.pendingConnections.length === 0; step++) {
		await vi.advanceTimersByTimeAsync(100);
		await new Promise((resolve) => setImmediate(resolve));
	}

	return server.nextConnection();
}

/** Resolves once the producer has handled every frame sent before it, failing on any frame it sent meanwhile. */
async function sync(socket: FakeProducerSocket): Promise<void> {
	socket.send(IngestOpcode.PING);

	expect(await socket.nextFrame()).toEqual({ op: 'PONG' });
}

async function events(socket: FakeProducerSocket, count: number): Promise<IngestEnvelope[]> {
	const frames: IngestEnvelope[] = [];

	for (let index = 0; index < count; index++) {
		frames.push(await socket.nextFrame());
	}

	return frames;
}

function update(id: number) {
	return { data: new Uint8Array([id]) };
}

function forward(...ids: number[]): void {
	for (const id of ids) {
		connection?.send(TelegramOpcode.UPDATE, update(id));
	}
}

function event(seq: number, id = seq) {
	return { op: 'UPDATE', d: update(id), seq };
}

/** An outbox file in a fresh directory, deleted when the test ends. */
function outboxFile(): string {
	const directory = mkdtempSync(join(tmpdir(), 'outbox-'));

	onTestFinished(() => rmSync(directory, { recursive: true, force: true }));

	return join(directory, 'outbox.sqlite');
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	server = await FakeIngestServer.start();
	onFatal.mockClear();
});

afterEach(async () => {
	connection?.stop();
	connection = undefined;
	outbox.close();
	await server.close();
	vi.useRealTimers();
});

describe('IngestConnection', () => {
	it('declares its route, version and key on the URL', async () => {
		connect();

		const socket = await server.nextConnection();

		expect(socket.url.pathname).toBe('/telegram/v1');
		expect(socket.url.searchParams.get('layer')).toBe('229');
		expect(socket.url.searchParams.get('api_key')).toBe('tc_key');
	});

	it('answers HELLO with IDENTIFY naming the account and the outbox stream', async () => {
		connect();

		const socket = await server.nextConnection();

		socket.hello();

		expect(await socket.nextFrame()).toEqual({
			op: 'IDENTIFY',
			d: { ...IDENTITY, streamId: outbox.streamId },
		});
	});

	it('sends no event before READY, then streams them in seq order', async () => {
		connect();
		forward(1, 2);

		const socket = await server.nextConnection();

		socket.hello();

		expect(await socket.nextFrame()).toMatchObject({ op: 'IDENTIFY' });

		forward(3);
		await sync(socket);
		socket.send(IngestOpcode.READY, { lastSeq: 0 });

		expect(await events(socket, 3)).toEqual([event(1), event(2), event(3)]);
	});

	it('deletes every event a cumulative ACK covers', async () => {
		connect();

		const socket = await streaming();

		forward(1, 2, 3);
		await events(socket, 3);
		socket.send(IngestOpcode.ACK, { seq: 2 });
		await sync(socket);

		expect(outbox.after(0, 10).map(({ seq }) => seq)).toEqual([3]);
	});

	it('keeps at most the window unacknowledged', async () => {
		connect({ window: 2 });

		const socket = await streaming();

		forward(1, 2, 3, 4);

		expect(await events(socket, 2)).toEqual([event(1), event(2)]);

		await sync(socket);
		socket.send(IngestOpcode.ACK, { seq: 1 });

		expect(await socket.nextFrame()).toEqual(event(3));

		await sync(socket);
	});

	it('rewinds to lastSeq + 1 when a READY arrives mid-stream', async () => {
		connect();

		const socket = await streaming();

		forward(1, 2, 3);
		await events(socket, 3);
		socket.send(IngestOpcode.READY, { lastSeq: 1 });

		expect(await events(socket, 2)).toEqual([event(2), event(3)]);
		expect(outbox.size).toBe(2);
	});

	it('numbers the next event past lastSeq when the server is ahead of the outbox', async () => {
		connect();
		forward(1, 2);

		const socket = await server.nextConnection();

		socket.hello();
		await socket.ready(10);
		await sync(socket);

		expect(outbox.size).toBe(0);

		forward(3);

		expect(await socket.nextFrame()).toEqual(event(11, 3));
	});

	it('streams from its lowest event when it no longer holds lastSeq + 1', async () => {
		connect();
		forward(1, 2, 3, 4, 5);
		outbox.acknowledge(3);

		const socket = await server.nextConnection();

		socket.hello();
		await socket.ready(1);

		expect(await events(socket, 2)).toEqual([event(4), event(5)]);
	});

	it('keeps an event the server refused until the ACK that follows covers it', async () => {
		connect();

		const socket = await streaming();

		forward(1, 2);
		await events(socket, 2);
		socket.send(IngestOpcode.ERROR, {
			code: IngestErrorCode.VALIDATION_ERROR,
			message: 'bad',
			seq: 1,
		});
		await sync(socket);

		expect(outbox.size).toBe(2);

		socket.send(IngestOpcode.ACK, { seq: 2 });
		await sync(socket);

		expect(outbox.size).toBe(0);
	});

	it('replays exactly the unacknowledged tail after a drop', async () => {
		connect();

		const socket = await streaming();

		forward(1, 2, 3);
		await events(socket, 3);
		socket.send(IngestOpcode.ACK, { seq: 1 });
		await sync(socket);
		socket.terminate();

		const resumed = await reconnected();

		resumed.hello();
		await resumed.ready(1);

		expect(await events(resumed, 2)).toEqual([event(2), event(3)]);
	});

	it('keeps events across a restart on the same outbox file and replays them on READY', async () => {
		const file = outboxFile();

		connect({ outbox: new Outbox(file) });

		const first = await streaming();
		const { streamId } = outbox;

		forward(1, 2, 3);
		await events(first, 3);
		first.send(IngestOpcode.ACK, { seq: 1 });
		await sync(first);
		connection?.stop();
		await first.closed;
		forward(4);
		outbox.close();

		connect({ outbox: new Outbox(file) });

		const second = await server.nextConnection();

		second.hello();

		const identify = await second.ready(1);

		expect(identify.d).toEqual({ ...IDENTITY, streamId });
		expect(await events(second, 3)).toEqual([event(2), event(3), event(4)]);
	});

	it('answers PING with PONG and reconnects when the server goes silent', async () => {
		connect();

		const socket = await streaming();

		await sync(socket);
		await vi.advanceTimersByTimeAsync(59_999);

		expect(server.pendingConnections).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1);
		await socket.closed;

		await expect(reconnected()).resolves.toBeDefined();
	});

	it.each([
		[4001, 'INVALID_API_KEY'],
		[4001, 'PLATFORM_MISMATCH'],
		[4001, 'IDENTITY_MISMATCH'],
		[4003, 'VERSION_UNSUPPORTED 214-229'],
		[4004, 'SUPERSEDED'],
	])('stops for good after %i %s', async (code, reason) => {
		connect();

		const socket = await server.nextConnection();

		socket.close(code, reason);
		await socket.closed;
		await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith(`${code} ${reason}`));
		await vi.advanceTimersByTimeAsync(60_000);

		expect(server.pendingConnections).toHaveLength(0);
	});

	it.each(['Authentication error', 'Identification error'])(
		'retries after 4001 %s',
		async (reason) => {
			connect();

			const socket = await server.nextConnection();

			socket.close(4001, reason);

			await expect(reconnected()).resolves.toBeDefined();
			expect(onFatal).not.toHaveBeenCalled();
		},
	);

	it('retries when the server could not store a batch', async () => {
		connect();

		const socket = await streaming();

		socket.close(1011, 'INTERNAL_ERROR');

		await expect(reconnected()).resolves.toBeDefined();
		expect(onFatal).not.toHaveBeenCalled();
	});

	it('stops for good when the route is refused with HTTP 404', async () => {
		server.refuseWith = 404;
		connect();

		await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith('HTTP 404'));
	});

	it('answers a request once under its nonce, outside the stream', async () => {
		connect({
			requests: {
				[TelegramOpcode.PROBE]: defineRequest({
					payload: IngestProbeSchema,
					result: TelegramOpcode.PROBE_RESULT,
					resultSchema: IngestProbeResultSchema,
					handle: async ({ token }) => ({ token }),
				}),
			},
		});

		const socket = await streaming();

		socket.send(TelegramOpcode.PROBE, { token: 'probe-1' }, 'request-1');

		expect(await socket.nextFrame()).toEqual({
			op: 'PROBE_RESULT',
			d: { token: 'probe-1' },
			nonce: 'request-1',
		});
		expect(outbox.size).toBe(0);
	});

	it('never sends a result that fails its schema', async () => {
		connect({
			requests: {
				[TelegramOpcode.PROBE]: defineRequest({
					payload: IngestProbeSchema,
					result: TelegramOpcode.PROBE_RESULT,
					resultSchema: z.object({ token: z.string().min(5) }),
					handle: async ({ token }) => ({ token }),
				}),
			},
		});

		const socket = await streaming();

		socket.send(TelegramOpcode.PROBE, { token: 'x' }, 'short');
		socket.send(TelegramOpcode.PROBE, { token: 'long enough' }, 'long');

		expect(await socket.nextFrame()).toMatchObject({ nonce: 'long' });
	});

	it('numbers snapshot parts from 0 and marks only the last done', async () => {
		async function* parts() {
			yield { chats: new Uint8Array([1]) };
			yield { chats: new Uint8Array([2]) };
		}

		connect({
			requests: {
				[TelegramOpcode.CHATS_FETCH]: defineSnapshot({
					result: TelegramOpcode.CHATS_FETCH_RESULT,
					partSchema: TelegramChatsPart,
					parts,
				}),
			},
		});

		const socket = await streaming();

		socket.send(TelegramOpcode.CHATS_FETCH, {}, 'snapshot');

		expect(await socket.nextFrame()).toEqual({
			op: 'CHATS_FETCH_RESULT',
			d: { part: 0, done: false, chats: new Uint8Array([1]) },
			nonce: 'snapshot',
		});
		expect(await socket.nextFrame()).toEqual({
			op: 'CHATS_FETCH_RESULT',
			d: { part: 1, done: true, chats: new Uint8Array([2]) },
			nonce: 'snapshot',
		});
	});

	it('answers an empty snapshot with one empty part marked done', async () => {
		connect({
			requests: {
				[TelegramOpcode.CHATS_FETCH]: defineSnapshot({
					result: TelegramOpcode.CHATS_FETCH_RESULT,
					partSchema: TelegramChatsPart,
					async *parts() {
						yield* [];
					},
				}),
			},
		});

		const socket = await streaming();

		socket.send(TelegramOpcode.CHATS_FETCH, {}, 'snapshot');

		expect(await socket.nextFrame()).toEqual({
			op: 'CHATS_FETCH_RESULT',
			d: { part: 0, done: true },
			nonce: 'snapshot',
		});
	});
});
