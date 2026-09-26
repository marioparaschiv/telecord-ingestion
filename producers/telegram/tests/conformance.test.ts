import { Long, PeersIndex, RawUpdateInfo, type TelegramClient } from '@mtcute/node';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	FakeIngestServer,
	type ConnectVector,
	type EventVector,
	type FakeProducerSocket,
	type RequestVector,
	type VectorFrame,
} from '@telecord/producer-core/testing';
import {
	TelegramChatsPart,
	TelegramMediaFetchResult,
	TelegramMessagesFetchResult,
	TelegramOpcode,
	TelegramUpdate,
} from '@telecord/ingest-client/telegram';
import { IngestErrorCode, IngestOpcode, IngestProbeResultSchema } from '@telecord/ingest-client';
import type { Filter } from '@telecord/producer-core';

import {
	DEFAULT_FILTER,
	bindings,
	bytesOf,
	createOfflineClient,
	decodeObject,
	vectorChats,
	dialogOf,
	iterate,
	narrow,
	seedPeers,
	vector,
	vectorUpdates,
	vectors,
} from './fixtures';
import { createTelegramProducer } from '../src/producer';

const CHANNEL_PEER_ID = '-1001987654321';

const DENY_CHANNEL: Filter = {
	rules: [{ action: 'deny', match: { peerId: [CHANNEL_PEER_ID] } }],
	fallback: 'allow',
};

/** Errors after which the producer drops the frame instead of resending it. */
const UNRECOVERABLE_ERRORS: readonly IngestErrorCode[] = [
	IngestErrorCode.VALIDATION_ERROR,
	IngestErrorCode.UNKNOWN_OPCODE,
	IngestErrorCode.MISSING_PERMISSION,
];

const RESULT_SCHEMAS = new Map<string, z.ZodType>([
	[TelegramOpcode.PROBE_RESULT, IngestProbeResultSchema],
	[TelegramOpcode.MESSAGES_FETCH_RESULT, TelegramMessagesFetchResult],
	[TelegramOpcode.MEDIA_FETCH_RESULT, TelegramMediaFetchResult],
	[TelegramOpcode.CHATS_FETCH_RESULT, TelegramChatsPart],
]);

const ErrorAnswerSchema = z.object({ code: z.enum(IngestErrorCode) });

const connects = vectors.vectors.filter(
	(candidate): candidate is ConnectVector => candidate.kind === 'connect',
);
const events = vectors.vectors.filter(
	(candidate): candidate is EventVector => candidate.kind === 'event',
);
const requests = vectors.vectors.filter(
	(candidate): candidate is RequestVector => candidate.kind === 'request',
);

let server: FakeIngestServer;
let client: TelegramClient;
let producer: ReturnType<typeof createTelegramProducer>;
const onFatal = vi.fn<(reason: string) => void>();

function start(filter: Filter = DEFAULT_FILTER): void {
	producer = createTelegramProducer({
		client,
		filter,
		url: server.url,
		apiKey: bindings.key,
		onFatal,
	});
	producer.connection.start();
}

function helloFrame(connect: ConnectVector = helloVector()): VectorFrame {
	if (!('frame' in connect.expect)) {
		throw new Error(`${connect.id} expects no frame`);
	}

	return connect.expect.frame;
}

function helloVector(): ConnectVector {
	const hello = vector('connect/hello');

	if (hello.kind !== 'connect') {
		throw new Error('connect/hello is not a connect vector');
	}

	return hello;
}

async function greeted(hello: VectorFrame = helloFrame()): Promise<FakeProducerSocket> {
	const socket = await server.nextConnection();

	socket.send(IngestOpcode.HELLO, hello.d);

	return socket;
}

function forwardVectorUpdate(): void {
	const container = vectorUpdates();
	const [update] = container.updates;

	if (!update) {
		throw new Error('event/update carries no update');
	}

	producer.updates.onRawUpdate(new RawUpdateInfo(update, PeersIndex.from(container)));
}

function field(frame: VectorFrame | undefined, name: string): unknown {
	const payload = frame?.d;

	if (typeof payload !== 'object' || payload === null || !(name in payload)) {
		throw new Error(`Reply lacks ${name}`);
	}

	return Reflect.get(payload, name);
}

beforeEach(async () => {
	server = await FakeIngestServer.start();
	client = await createOfflineClient();
	onFatal.mockClear();

	await seedPeers(client, vectorUpdates());
});

afterEach(async () => {
	producer.connection.stop();
	await server.close();
	await client.destroy();
	vi.restoreAllMocks();
	vi.useRealTimers();
});

describe('connect vectors', () => {
	it('declares the route, mtcute layer and key the way connect/hello does', async () => {
		start();

		const socket = await server.nextConnection();
		const expected = new URL(helloVector().url, server.url);

		expect(`${socket.url.pathname}${socket.url.search}`).toBe(
			`${expected.pathname}${expected.search}`,
		);
	});

	it.each(connects.filter(({ expect }) => 'frame' in expect).map((c) => [c.id, c] as const))(
		'%s: honours HELLO and answers the snapshot that follows',
		async (_id, connect) => {
			vi.spyOn(client, 'iterDialogs').mockReturnValue(iterate([]));
			start();

			const socket = await greeted(helloFrame(connect));

			forwardVectorUpdate();

			expect(await socket.nextFrame()).toMatchObject({ op: TelegramOpcode.UPDATE });

			if (!connect.chatsFetch) {
				return;
			}

			socket.send(TelegramOpcode.CHATS_FETCH, {}, 'snapshot');

			expect(await socket.nextFrame()).toEqual({
				op: TelegramOpcode.CHATS_FETCH_RESULT,
				d: { part: 0, done: true },
				nonce: 'snapshot',
			});
		},
	);

	it.each(connects.filter(({ expect }) => !('frame' in expect)).map((c) => [c.id, c] as const))(
		'%s: stops for good',
		async (_id, { expect: expected }) => {
			if ('status' in expected) {
				server.refuseWith = expected.status;
				start();
				await vi.waitFor(() =>
					expect(onFatal).toHaveBeenCalledWith(`HTTP ${expected.status}`),
				);

				return;
			}

			if (!('close' in expected)) {
				throw new Error('A connect vector expects a frame, a close or a status');
			}

			const { code, reason } = expected.close;

			start();
			(await server.nextConnection()).close(code, reason);

			await vi.waitFor(() => expect(onFatal).toHaveBeenCalledWith(`${code} ${reason}`));
		},
	);
});

describe('event vectors', () => {
	it('forwards the event/update container byte for byte', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.setSystemTime(vectorUpdates().date * 1000);
		start();

		const socket = await greeted();

		forwardVectorUpdate();

		const frame = await socket.nextFrame();
		const expected = vector('event/update');

		if (expected.kind !== 'event') {
			throw new Error('event/update is not an event vector');
		}

		expect({ op: frame.op, d: frame.d }).toEqual({ op: expected.send.op, d: expected.send.d });
		expect(TelegramUpdate.safeParse(frame.d).success).toBe(true);
		expect(frame.nonce).toEqual(expect.any(String));
	});

	it.each(events.map((event) => [event.id, event] as const))(
		'%s: keeps or drops the frame the way the answer says',
		async (_id, { expect: answer }) => {
			start();

			const socket = await greeted();

			forwardVectorUpdate();

			const frame = await socket.nextFrame();
			const error =
				answer.op === IngestOpcode.ERROR ? ErrorAnswerSchema.parse(answer.d) : undefined;
			const nonce = answer.nonce === undefined ? undefined : frame.nonce;

			if (error) {
				socket.send(
					IngestOpcode.ERROR,
					{ code: error.code, message: 'from a vector' },
					nonce,
				);
			} else {
				socket.send(IngestOpcode.ACK, null, nonce);
			}

			socket.send(IngestOpcode.PING);

			expect(await socket.nextFrame()).toEqual({ op: IngestOpcode.PONG });

			const kept =
				nonce === undefined ||
				(error !== undefined && !UNRECOVERABLE_ERRORS.includes(error.code));

			expect(producer.connection.unacknowledged).toBe(kept ? 1 : 0);
		},
	);
});

describe('request vectors', () => {
	/** Stubs the Telegram side of an accepted vector and returns the filter it runs under. */
	function arrange(id: string, reply: VectorFrame[]): Filter {
		const call = vi.spyOn(client, 'call').mockRejectedValue(new Error('No call expected'));
		const download = vi.spyOn(client, 'downloadAsIterable').mockImplementation(() => {
			throw new Error('No download expected');
		});
		const upload = vi
			.spyOn(globalThis, 'fetch')
			.mockRejectedValue(new Error('No upload expected'));
		const [first] = reply;

		switch (id) {
			case 'request/chats-fetch': {
				const { forum, group, topics } = vectorChats();

				vi.spyOn(client, 'iterDialogs').mockReturnValue(
					iterate([
						dialogOf({ _: 'peerChannel', channelId: forum.id }, [forum]),
						dialogOf({ _: 'peerChat', chatId: group.id }, [group]),
					]),
				);
				call.mockImplementation(async (request) => {
					expect(request._).toBe('messages.getForumTopics');

					return topics;
				});

				return DEFAULT_FILTER;
			}

			case 'request/messages-fetch-ids':
			case 'request/messages-fetch-range': {
				const messages = decodeObject(field(first, 'messages'));
				const method =
					id === 'request/messages-fetch-ids'
						? 'channels.getMessages'
						: 'messages.getHistory';

				call.mockImplementation(async (request) => {
					expect(request._).toBe(method);

					return narrow(messages, 'messages.channelMessages');
				});

				return DEFAULT_FILTER;
			}

			case 'request/media-fetch':
			case 'request/media-fetch-custom-emoji': {
				const size = z.number().parse(field(first, 'bytes'));

				download.mockImplementation(() => bytesOf(size));
				upload.mockResolvedValue(new Response(null, { status: 204 }));
				call.mockImplementation(async (request) => {
					expect(request._).toBe('messages.getCustomEmojiDocuments');

					return [
						{
							_: 'document',
							id: Long.fromString('5368324170671202287'),
							accessHash: Long.fromNumber(7),
							fileReference: new Uint8Array([1]),
							date: 0,
							mimeType: 'image/webp',
							size,
							dcId: 4,
							attributes: [],
						},
					];
				});

				return DEFAULT_FILTER;
			}

			case 'request/messages-fetch-filtered':
			case 'request/media-fetch-filtered':
				return DENY_CHANNEL;

			default:
				return DEFAULT_FILTER;
		}
	}

	it.each(
		requests
			.filter(({ outcome }) => outcome === 'accepted')
			.map((request) => [request.id, request] as const),
	)('%s: answers with exactly the vector reply', async (id, request) => {
		const filter = arrange(id, request.reply);

		start(filter);

		const socket = await greeted();
		const nonce = `nonce-${id}`;

		socket.send(z.enum(TelegramOpcode).parse(request.request.op), request.request.d, nonce);

		for (const expected of request.reply) {
			expect(await socket.nextFrame()).toEqual({ op: expected.op, d: expected.d, nonce });
		}

		if (filter === DENY_CHANNEL) {
			expect(client.call).not.toHaveBeenCalled();
			expect(client.downloadAsIterable).not.toHaveBeenCalled();
		}
	});

	it.each(
		requests
			.filter(({ outcome }) => outcome === 'refused')
			.map((request) => [request.id, request] as const),
	)('%s: is a reply the producer never sends', (_id, { reply }) => {
		const [first] = reply;
		const schema = RESULT_SCHEMAS.get(first?.op ?? '');

		if (!schema) {
			throw new Error(`No result schema for ${first?.op}`);
		}

		const malformed = reply.some(({ d }) => !schema.safeParse(d).success);
		// Parts are numbered from 0 by the producer, so a snapshot opening on any other part is never sent.
		const outOfOrder =
			first?.op === TelegramOpcode.CHATS_FETCH_RESULT && field(first, 'part') !== 0;

		expect(malformed || outOfOrder).toBe(true);
	});
});
