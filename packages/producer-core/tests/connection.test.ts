import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	IngestErrorCode,
	IngestOpcode,
	IngestProbeResultSchema,
	IngestProbeSchema,
} from '@telecord/ingest-client';
import { TelegramChatsPart, TelegramOpcode } from '@telecord/ingest-client/telegram';

import { FakeIngestServer, type FakeProducerSocket } from '../src/testing';
import IngestConnection, { RESEND_DELAY } from '../src/connection';
import { defineRequest, defineSnapshot } from '../src/requests';

let server: FakeIngestServer;
let connection: IngestConnection | undefined;
const onFatal = vi.fn<(reason: string) => void>();

function connect(requests: ConstructorParameters<typeof IngestConnection>[0]['requests'] = {}) {
	connection = new IngestConnection({
		url: server.url,
		apiKey: 'tc_key',
		route: '/telegram/v1',
		versionParam: 'layer',
		version: 229,
		requests,
		onFatal,
	});
	connection.start();

	return connection;
}

async function greeted(): Promise<FakeProducerSocket> {
	const socket = await server.nextConnection();

	socket.hello();

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

/** Resolves once the producer has handled every frame sent before it. */
async function sync(socket: FakeProducerSocket): Promise<void> {
	socket.send(IngestOpcode.PING);

	expect(await socket.nextFrame()).toEqual({ op: 'PONG' });
}

function update(id: number) {
	return { data: new Uint8Array([id]) };
}

beforeEach(async () => {
	vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
	server = await FakeIngestServer.start();
	onFatal.mockClear();
});

afterEach(async () => {
	connection?.stop();
	connection = undefined;
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

	it('holds events until HELLO, then sends them one at a time in order', async () => {
		const producer = connect();

		producer.send(TelegramOpcode.UPDATE, update(1));
		producer.send(TelegramOpcode.UPDATE, update(2));

		const socket = await server.nextConnection();

		expect(socket.pendingFrames).toHaveLength(0);

		socket.hello();

		const first = await socket.nextFrame();

		expect(first).toMatchObject({ op: 'UPDATE', d: update(1) });
		expect(first.nonce).toEqual(expect.any(String));
		expect(socket.pendingFrames).toHaveLength(0);

		socket.send(IngestOpcode.ACK, null, first.nonce);

		const second = await socket.nextFrame();

		expect(second).toMatchObject({ op: 'UPDATE', d: update(2) });
		expect(second.nonce).not.toBe(first.nonce);
	});

	it('resends unacknowledged frames in their original order after a reconnect', async () => {
		const producer = connect();
		const socket = await greeted();

		producer.send(TelegramOpcode.UPDATE, update(1));
		producer.send(TelegramOpcode.UPDATE, update(2));
		producer.send(TelegramOpcode.UPDATE, update(3));

		const first = await socket.nextFrame();

		socket.send(IngestOpcode.ACK, null, first.nonce);

		const second = await socket.nextFrame();

		socket.terminate();

		const resumed = await reconnected();

		resumed.hello();

		const resent = await resumed.nextFrame();

		expect(resent).toEqual(second);

		resumed.send(IngestOpcode.ACK, null, resent.nonce);

		expect(await resumed.nextFrame()).toMatchObject({ op: 'UPDATE', d: update(3) });
		expect(producer.unacknowledged).toBe(1);
	});

	it('drops a frame the server refuses as malformed and moves on', async () => {
		const producer = connect();
		const socket = await greeted();

		producer.send(TelegramOpcode.UPDATE, update(1));
		producer.send(TelegramOpcode.UPDATE, update(2));

		const refused = await socket.nextFrame();

		socket.send(
			IngestOpcode.ERROR,
			{ code: IngestErrorCode.VALIDATION_ERROR, message: 'bad' },
			refused.nonce,
		);

		expect(await socket.nextFrame()).toMatchObject({ d: update(2) });
		expect(producer.unacknowledged).toBe(1);
	});

	it('keeps a frame the server could not park and resends it later', async () => {
		const producer = connect();
		const socket = await greeted();

		producer.send(TelegramOpcode.UPDATE, update(1));

		const parked = await socket.nextFrame();

		socket.send(
			IngestOpcode.ERROR,
			{ code: IngestErrorCode.PARK_LIMIT_REACHED, message: 'full' },
			parked.nonce,
		);
		await sync(socket);
		await vi.advanceTimersByTimeAsync(RESEND_DELAY - 1);

		expect(socket.pendingFrames).toHaveLength(0);

		await vi.advanceTimersByTimeAsync(1);

		expect(await socket.nextFrame()).toEqual(parked);
		expect(producer.unacknowledged).toBe(1);
	});

	it('answers PING with PONG and reconnects when the server goes silent', async () => {
		connect();

		const socket = await greeted();

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
		[4003, 'VERSION_UNSUPPORTED 214-229'],
	])('stops for good after %i %s', async (code, reason) => {
		connect();

		const socket = await server.nextConnection();

		socket.close(code, reason);
		await socket.closed;
		await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith(`${code} ${reason}`));
		await vi.advanceTimersByTimeAsync(60_000);

		expect(server.pendingConnections).toHaveLength(0);
	});

	it('retries when the server failed while checking the key', async () => {
		connect();

		const socket = await server.nextConnection();

		socket.close(4001, 'Authentication error');

		await expect(reconnected()).resolves.toBeDefined();
		expect(onFatal).not.toHaveBeenCalled();
	});

	it('stops for good when the route is refused with HTTP 404', async () => {
		server.refuseWith = 404;
		connect();

		await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith('HTTP 404'));
	});

	it('answers a request once under its nonce', async () => {
		connect({
			[TelegramOpcode.PROBE]: defineRequest({
				payload: IngestProbeSchema,
				result: TelegramOpcode.PROBE_RESULT,
				resultSchema: IngestProbeResultSchema,
				handle: async ({ token }) => ({ token }),
			}),
		});

		const socket = await greeted();

		socket.send(TelegramOpcode.PROBE, { token: 'probe-1' }, 'request-1');

		expect(await socket.nextFrame()).toEqual({
			op: 'PROBE_RESULT',
			d: { token: 'probe-1' },
			nonce: 'request-1',
		});
	});

	it('never sends a result that fails its schema', async () => {
		connect({
			[TelegramOpcode.PROBE]: defineRequest({
				payload: IngestProbeSchema,
				result: TelegramOpcode.PROBE_RESULT,
				resultSchema: z.object({ token: z.string().min(5) }),
				handle: async ({ token }) => ({ token }),
			}),
		});

		const socket = await greeted();

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
			[TelegramOpcode.CHATS_FETCH]: defineSnapshot({
				result: TelegramOpcode.CHATS_FETCH_RESULT,
				partSchema: TelegramChatsPart,
				parts,
			}),
		});

		const socket = await greeted();

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
			[TelegramOpcode.CHATS_FETCH]: defineSnapshot({
				result: TelegramOpcode.CHATS_FETCH_RESULT,
				partSchema: TelegramChatsPart,
				async *parts() {
					yield* [];
				},
			}),
		});

		const socket = await greeted();

		socket.send(TelegramOpcode.CHATS_FETCH, {}, 'snapshot');

		expect(await socket.nextFrame()).toEqual({
			op: 'CHATS_FETCH_RESULT',
			d: { part: 0, done: true },
			nonce: 'snapshot',
		});
	});
});
