import {
	Long,
	MtPeerNotFoundError,
	PeersIndex,
	RawUpdateInfo,
	tl,
	type TelegramClient,
} from '@mtcute/node';
import { afterEach, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';

import {
	TelegramChatsPart,
	TelegramCustomEmojisFetchResult,
	TelegramForumTopicsFetchResult,
	TelegramMediaFetchResult,
	TelegramMessagesFetchResult,
	TelegramOpcode,
	TelegramUpdate,
	TelegramUsersFetchResult,
} from '@telecord/ingest-client/telegram';
import {
	FakeIngestServer,
	type ConnectVector,
	type EventVector,
	type FakeProducerSocket,
	type RequestVector,
	type VectorFrame,
} from '@telecord/producer-core/testing';
import { IngestOpcode, IngestProbeResultSchema } from '@telecord/ingest-client';
import { Outbox, type Filter } from '@telecord/producer-core';

import {
	DEFAULT_FILTER,
	bindings,
	bytesOf,
	createDownloadDir,
	createOfflineClient,
	decodeObject,
	decodeVector,
	failChannelFetch,
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
import { serializeVector } from '../src/tl';

const CHANNEL_PEER_ID = '-1001987654321';

const DENY_CHANNEL: Filter = {
	rules: [{ action: 'deny', match: { peerId: [CHANNEL_PEER_ID] } }],
	fallback: 'allow',
};

const RESULT_SCHEMAS = new Map<string, z.ZodType>([
	[TelegramOpcode.PROBE_RESULT, IngestProbeResultSchema],
	[TelegramOpcode.MESSAGES_FETCH_RESULT, TelegramMessagesFetchResult],
	[TelegramOpcode.MEDIA_FETCH_RESULT, TelegramMediaFetchResult],
	[TelegramOpcode.CHATS_FETCH_RESULT, TelegramChatsPart],
	[TelegramOpcode.USERS_FETCH_RESULT, TelegramUsersFetchResult],
	[TelegramOpcode.CUSTOM_EMOJIS_FETCH_RESULT, TelegramCustomEmojisFetchResult],
	[TelegramOpcode.FORUM_TOPICS_FETCH_RESULT, TelegramForumTopicsFetchResult],
]);

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
let outbox: Outbox;
const onFatal = vi.fn<(reason: string) => void>();

function start(filter: Filter = DEFAULT_FILTER): void {
	const downloads = createDownloadDir();

	outbox = new Outbox(':memory:');
	onTestFinished(() => {
		outbox.close();
		downloads.remove();
	});
	producer = createTelegramProducer({
		client,
		filter,
		url: server.url,
		apiKey: bindings.key,
		outbox,
		window: 500,
		downloadDir: downloads.path,
		onFatal,
	});
	producer.updates.start();
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
	await socket.ready();

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

describe('identify', () => {
	it('answers HELLO with the IDENTIFY the vectors send, on its own stream', async () => {
		start();

		const socket = await server.nextConnection();

		socket.send(IngestOpcode.HELLO, helloFrame().d);

		const { op, d } = await socket.nextFrame();

		expect({ op, d }).toEqual({
			op: vectors.identify.op,
			d: {
				...z.looseObject({}).parse(vectors.identify.d),
				requests: ['CUSTOM_EMOJIS_FETCH', 'FORUM_TOPICS_FETCH'],
				streamId: outbox.streamId,
				recovered: true,
			},
		});
	});

	it('reports recovered: false once mtcute skipped updates', async () => {
		start();
		producer.session.onUpdatesSkipped('Telegram answered updates.differenceTooLong');

		const socket = await server.nextConnection();

		socket.send(IngestOpcode.HELLO, helloFrame().d);

		expect((await socket.nextFrame()).d).toMatchObject({ recovered: false });
	});

	it('writes each forwarded update to the outbox before its handler returns', () => {
		start();
		forwardVectorUpdate();

		expect(outbox.captures()).toHaveLength(1);
	});
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
		expect(frame.seq).toBe(1);
	});

	it.each([
		['Telegram answers CHANNEL_PRIVATE', new tl.RpcError(400, 'CHANNEL_PRIVATE')],
		['the session can no longer resolve the channel', 'unresolvable'],
	] as const)(
		'forwards the event/update-access-lost container byte for byte once %s',
		async (_cause, failure) => {
			const expected = vector('event/update-access-lost');

			if (expected.kind !== 'event') {
				throw new Error('event/update-access-lost is not an event vector');
			}

			const sent = narrow(
				decodeObject(z.object({ data: z.unknown() }).parse(expected.send.d).data),
				'updates',
			);
			const [update] = sent.updates;
			const [channel] = vectorUpdates().chats;

			if (!update || channel?._ !== 'channel') {
				throw new Error(
					'event/update-access-lost lost its update, or event/update its channel',
				);
			}

			// A session that only ever saw the channel min, so shipping the update means fetching it.
			await client.destroy();
			client = await createOfflineClient();
			vi.useFakeTimers({ toFake: ['Date'] });
			vi.setSystemTime(sent.date * 1000);
			start();

			const socket = await greeted();

			failChannelFetch(client, channel, failure);
			producer.updates.onRawUpdate(
				new RawUpdateInfo(update, PeersIndex.from({ chats: [{ ...channel, min: true }] })),
			);

			const frame = await socket.nextFrame();

			expect({ op: frame.op, d: frame.d }).toEqual({
				op: expected.send.op,
				d: expected.send.d,
			});
		},
	);

	it.each(events.map((event) => [event.id, event] as const))(
		'%s: keeps the event until an ACK covers it',
		async (_id, { expect: answer }) => {
			start();

			const socket = await greeted();

			forwardVectorUpdate();
			await socket.nextFrame();

			const acknowledged = answer.op === IngestOpcode.ACK;

			socket.send(
				z.enum(IngestOpcode).parse(answer.op),
				acknowledged
					? answer.d
					: { ...z.looseObject({}).parse(answer.d), message: 'from a vector' },
			);
			socket.send(IngestOpcode.PING);

			expect(await socket.nextFrame()).toEqual({ op: IngestOpcode.PONG });
			expect(outbox.size).toBe(acknowledged ? 0 : 1);
		},
	);
});

describe('request vectors', () => {
	/** Stubs the Telegram side of an accepted vector and returns the filter it runs under. */
	async function arrange(id: string, reply: VectorFrame[]): Promise<Filter> {
		const call = vi.spyOn(client, 'call').mockRejectedValue(new Error('No call expected'));
		const download = vi.spyOn(client, 'downloadAsIterable').mockImplementation(() => {
			throw new Error('No download expected');
		});
		const upload = vi
			.spyOn(globalThis, 'fetch')
			.mockRejectedValue(new Error('No upload expected'));
		const [first] = reply;

		// Resolved from the session's cache alone, which the vectors' peers are seeded into.
		vi.spyOn(client, 'resolvePeer').mockImplementation(async (peerId) => {
			const peer = await client.storage.peers.getById(Number(peerId));

			if (!peer) {
				throw new MtPeerNotFoundError(`Peer ${String(peerId)} is not found in local cache`);
			}

			return peer;
		});

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

			case 'request/chats-fetch-top-messages': {
				const [group] = decodeVector(field(first, 'chats'));

				if (!group) {
					throw new Error(`${id} names no chat`);
				}

				const chat = narrow(group, 'chat');
				const [top] = z
					.array(z.object({ messageId: z.number() }))
					.parse(field(first, 'topMessages'));

				vi.spyOn(client, 'iterDialogs').mockReturnValue(
					iterate([
						dialogOf({ _: 'peerChat', chatId: chat.id }, [chat], [], top?.messageId),
					]),
				);

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

			case 'request/media-fetch-progress': {
				// Each part lands a progress interval after the last, but the final one, which only
				// the result reports.
				const parts: [bytes: number, after: number][] = [
					[1_048_576, 15_000],
					[19_922_944, 15_000],
					[2_097_152, 0],
				];

				vi.useFakeTimers({ toFake: ['Date'] });
				onTestFinished(() => {
					vi.useRealTimers();
				});
				download.mockImplementation(async function* () {
					for (const [bytes, after] of parts) {
						vi.setSystemTime(Date.now() + after);

						yield new Uint8Array(bytes);
					}
				});
				upload.mockResolvedValue(new Response(null, { status: 204 }));

				return DEFAULT_FILTER;
			}

			case 'request/custom-emojis-fetch': {
				const documents = decodeVector(field(first, 'documents'));

				call.mockImplementation(async (request) => {
					expect(request._).toBe('messages.getCustomEmojiDocuments');

					return documents;
				});

				return DEFAULT_FILTER;
			}

			case 'request/forum-topics-fetch': {
				const [page] = z.array(z.instanceof(Uint8Array)).parse(field(first, 'topics'));

				call.mockImplementation(async (request) => {
					expect(request._).toBe('messages.getForumTopics');

					return narrow(decodeObject(page), 'messages.forumTopics');
				});

				return DEFAULT_FILTER;
			}

			case 'request/users-fetch': {
				const users = decodeVector(field(first, 'users')).map((user) =>
					narrow(user, 'user'),
				);

				await seedPeers(client, { users });
				call.mockImplementation(async (request) => {
					expect(request._).toBe('users.getUsers');

					return users;
				});

				return DEFAULT_FILTER;
			}

			case 'request/messages-fetch-filtered':
			case 'request/media-fetch-filtered':
			case 'request/forum-topics-fetch-filtered':
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
		const filter = await arrange(id, request.reply);

		start(filter);

		const socket = await greeted();
		const nonce = `nonce-${id}`;

		socket.send(z.enum(TelegramOpcode).parse(request.request.op), request.request.d, nonce);

		for (const expected of request.reply) {
			// Every part carries users and topics, empty when it has none; a vector may leave them out.
			const d =
				expected.op === TelegramOpcode.CHATS_FETCH_RESULT
					? {
							users: serializeVector([]),
							topics: [],
							...z.looseObject({}).parse(expected.d),
						}
					: expected.d;

			expect(await socket.nextFrame()).toEqual({ op: expected.op, d, nonce });
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

describe('snapshot', () => {
	it("names each chat's newest message in the part that carries the chat", async () => {
		const { forum, group, topics } = vectorChats();

		vi.spyOn(client, 'iterDialogs').mockReturnValue(
			iterate([
				dialogOf({ _: 'peerChannel', channelId: forum.id }, [forum], [], 11),
				dialogOf({ _: 'peerChat', chatId: group.id }, [group], [], 12),
			]),
		);
		vi.spyOn(client, 'call').mockResolvedValue(topics);
		start();

		const socket = await greeted();

		socket.send(TelegramOpcode.CHATS_FETCH, {}, 'snapshot');

		const parts = [await socket.nextFrame(), await socket.nextFrame()].map(({ d }) =>
			TelegramChatsPart.parse(d),
		);

		expect(parts.map(({ topMessages }) => topMessages)).toEqual([
			[{ peerId: `-100${forum.id}`, messageId: 11 }],
			[{ peerId: `-${group.id}`, messageId: 12 }],
		]);
	});

	it('keeps a chat the dialog walk missed while Telegram still shows the account in it', async () => {
		const { group } = vectorChats();
		const busy: tl.RawChannel = {
			_: 'channel',
			id: 1_444_555_666,
			accessHash: Long.fromNumber(31),
			title: 'Busy Channel',
			photo: { _: 'chatPhotoEmpty' },
			date: 1_758_000_000,
			broadcast: true,
		};
		const friend: tl.RawUser = { _: 'user', id: 555_000_111, firstName: 'Friend' };
		const walks = [
			[
				dialogOf({ _: 'peerChat', chatId: group.id }, [group]),
				dialogOf({ _: 'peerChannel', channelId: busy.id }, [busy]),
				dialogOf({ _: 'peerUser', userId: friend.id }, [], [friend]),
			],
			[dialogOf({ _: 'peerChat', chatId: group.id }, [group])],
			[dialogOf({ _: 'peerChat', chatId: group.id }, [group])],
		];
		const lookups = [busy, { ...busy, left: true }];

		await seedPeers(client, { chats: [busy] });
		vi.spyOn(client, 'iterDialogs').mockImplementation(() => iterate(walks.shift() ?? []));

		const call = vi.spyOn(client, 'call').mockImplementation(async (method) => {
			if (method._ !== 'channels.getChannels') {
				throw new Error(`Unexpected call ${method._}`);
			}

			return { _: 'messages.chats', chats: [lookups.shift() ?? busy] };
		});

		start({ rules: [], fallback: 'allow' });

		const socket = await greeted();

		async function snapshotChatIds(nonce: string): Promise<number[]> {
			socket.send(TelegramOpcode.CHATS_FETCH, {}, nonce);

			const { chats = new Uint8Array() } = TelegramChatsPart.parse(
				(await socket.nextFrame()).d,
			);

			return decodeVector(chats).map(
				(chat) => narrow(chat, chat._ === 'chat' ? 'chat' : 'channel').id,
			);
		}

		expect(await snapshotChatIds('first')).toEqual([group.id, busy.id]);
		expect(await snapshotChatIds('missed')).toEqual([group.id, busy.id]);
		expect(await snapshotChatIds('left')).toEqual([group.id]);
		// The private chat was never re-checked: the server does not revoke one.
		expect(call).toHaveBeenCalledTimes(2);
	});
});
