import {
	Dialog,
	Long,
	MemoryStorage,
	MtPeerNotFoundError,
	PeersIndex,
	TelegramClient,
	User,
	tl,
} from '@mtcute/node';
import { TlBinaryReader, __tlReaderMap } from '@mtcute/node/utils.js';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { vi } from 'vitest';
import { z } from 'zod';

import {
	FakeIngestServer,
	loadVectors,
	type FakeProducerSocket,
	type VectorBindings,
	type VectorFrame,
} from '@telecord/producer-core/testing';
import telegramVectors from '@telecord/ingest-client/vectors/telegram.json' with { type: 'json' };
import { Outbox, resolveFilter, type Filter } from '@telecord/producer-core';

import { createTelegramProducer } from '../src/producer';
import { TelegramConfigSchema } from '../src/config';
import { TELEGRAM_FORWARD } from '../src/filter';

/** The account the offline session is logged in as, with the fields the vectors' `IDENTIFY` names. */
export const SELF: tl.RawUser = {
	_: 'user',
	id: 777_000_111,
	self: true,
	firstName: 'Conformance',
	username: 'conformance',
};

/** The layer window the vectors are materialized against: mtcute's layer is the newest. */
export const bindings: VectorBindings = {
	min: tl.LAYER - 15,
	max: tl.LAYER,
	key: 'tc_test_key',
	foreignKey: 'tc_foreign_key',
	unboundKey: 'tc_unbound_key',
	platformUserId: SELF.id,
	otherUserId: 777_000_222,
	streamId: '0190c3f6-6f1a-4c55-9d0e-3b1a2c4d5e6f',
};

export const vectors = loadVectors(telegramVectors, bindings);

/** The filter a producer starts with when no rules are configured. */
export const DEFAULT_FILTER: Filter = resolveFilter(
	{ filter: TelegramConfigSchema.shape.filter.parse({}), forward: {} },
	TELEGRAM_FORWARD,
);

/**
 * Finds a vector by id.
 *
 * @param id - The vector id.
 * @returns The vector.
 */
export function vector(id: string) {
	const found = vectors.vectors.find((candidate) => candidate.id === id);

	if (!found) {
		throw new Error(`No vector ${id}`);
	}

	return found;
}

/**
 * Reads one boxed TL object.
 *
 * @param bytes - The object's bytes.
 * @returns The object.
 */
export function decodeObject(bytes: unknown): tl.TlObject {
	if (!(bytes instanceof Uint8Array)) {
		throw new TypeError('Expected TL bytes');
	}

	const object = new TlBinaryReader(__tlReaderMap, bytes).object();

	if (typeof object !== 'object' || object === null || !('_' in object)) {
		throw new TypeError('Expected a boxed TL object');
	}

	// The reader is untyped; a boxed value with a constructor name is a TL object.
	return object as tl.TlObject;
}

/**
 * Reads one boxed TL vector.
 *
 * @param bytes - The vector's bytes.
 * @returns Its entries.
 */
export function decodeVector(bytes: unknown): tl.TlObject[] {
	if (!(bytes instanceof Uint8Array)) {
		throw new TypeError('Expected TL bytes');
	}

	return new TlBinaryReader(__tlReaderMap, bytes).vector().map((entry) => {
		if (typeof entry !== 'object' || entry === null || !('_' in entry)) {
			throw new TypeError('Expected boxed TL objects');
		}

		return entry as tl.TlObject;
	});
}

/** A TL object narrowed to one constructor, failing the test when it is another. */
export function narrow<Name extends tl.TlObject['_']>(
	object: tl.TlObject,
	name: Name,
): Extract<tl.TlObject, { _: Name }> {
	if (object._ !== name) {
		throw new TypeError(`Expected ${name}, got ${object._}`);
	}

	return object as Extract<tl.TlObject, { _: Name }>;
}

/** The `updates` container of the `event/update` vector: one channel message with its peers. */
export function vectorUpdates(): tl.RawUpdates {
	const event = vector('event/update');

	if (event.kind !== 'event' || typeof event.send.d !== 'object' || event.send.d === null) {
		throw new TypeError('event/update is not an UPDATE event');
	}

	return narrow(decodeObject('data' in event.send.d ? event.send.d.data : undefined), 'updates');
}

function replyField(frame: VectorFrame | undefined, name: string): unknown {
	const payload = frame?.d;

	if (typeof payload !== 'object' || payload === null || !(name in payload)) {
		throw new Error(`Vector reply lacks ${name}`);
	}

	return Reflect.get(payload, name);
}

/** The chats of the `request/chats-fetch` vector: a forum with one topic page, and a basic group. */
export function vectorChats(): {
	forum: tl.RawChannel;
	group: tl.RawChat;
	topics: tl.messages.RawForumTopics;
} {
	const snapshot = vector('request/chats-fetch');

	if (snapshot.kind !== 'request') {
		throw new TypeError('request/chats-fetch is not a request vector');
	}

	const [first, second] = snapshot.reply;
	const [forum] = decodeVector(replyField(first, 'chats'));
	const [group] = decodeVector(replyField(second, 'chats'));
	const [page] = z.array(z.instanceof(Uint8Array)).parse(replyField(first, 'topics'));

	if (!forum || !group || !page) {
		throw new Error('request/chats-fetch lost its forum, group or topic page');
	}

	return {
		forum: narrow(forum, 'channel'),
		group: narrow(group, 'chat'),
		topics: narrow(decodeObject(page), 'messages.forumTopics'),
	};
}

/**
 * A session on in-memory storage that never connects: every Telegram call a
 * test expects is stubbed on it.
 *
 * @returns The prepared client.
 */
export async function createOfflineClient(): Promise<TelegramClient> {
	const client = new TelegramClient({
		apiId: 1,
		apiHash: 'offline',
		storage: new MemoryStorage(),
		updates: false,
	});

	await client.prepare();
	vi.spyOn(client, 'getMe').mockResolvedValue(new User(SELF));

	return client;
}

/** A producer on an offline session, connected to a local ingest server and greeted. */
export type Harness = {
	server: FakeIngestServer;
	client: TelegramClient;
	producer: ReturnType<typeof createTelegramProducer>;
	socket: FakeProducerSocket;
	outbox: Outbox;
	/** Where the producer writes a file while `MEDIA_FETCH` downloads it. */
	downloadDir: string;
	close: () => Promise<void>;
};

/**
 * Starts a producer on an offline session seeded with the vectors' peers, and
 * greets its connection up to `READY`.
 *
 * @param filter - The producer's filter rules.
 * @returns The running harness.
 */
export async function startHarness(filter: Filter = DEFAULT_FILTER): Promise<Harness> {
	const server = await FakeIngestServer.start();
	const client = await createOfflineClient();

	await seedPeers(client, vectorUpdates());

	const outbox = new Outbox(':memory:');
	const downloads = createDownloadDir();
	const producer = createTelegramProducer({
		client,
		filter,
		url: server.url,
		apiKey: bindings.key,
		outbox,
		window: 500,
		downloadDir: downloads.path,
		onFatal: (reason) => {
			throw new Error(`Unexpected fatal refusal: ${reason}`);
		},
	});

	producer.updates.start();
	producer.connection.start();

	const socket = await server.nextConnection();

	socket.hello();
	await socket.ready();

	return {
		server,
		client,
		producer,
		socket,
		outbox,
		downloadDir: downloads.path,
		async close() {
			producer.connection.stop();
			await server.close();
			await client.destroy();
			outbox.close();
			downloads.remove();
		},
	};
}

/**
 * A directory for a producer's downloads that only this run uses.
 *
 * @returns The directory, and `remove` to delete it with whatever is left in it.
 */
export function createDownloadDir(): { path: string; remove: () => void } {
	const path = mkdtempSync(join(tmpdir(), 'telegram-downloads-'));

	return { path, remove: () => rmSync(path, { recursive: true, force: true }) };
}

/**
 * Seeds the session's peer cache with the users and chats of the vectors'
 * updates container, as if the session had seen them.
 *
 * @param client - The session.
 * @param peers - The users and chats to cache.
 */
export async function seedPeers(
	client: TelegramClient,
	peers: { users?: tl.TypeUser[]; chats?: tl.TypeChat[] },
): Promise<void> {
	for (const peer of [...(peers.users ?? []), ...(peers.chats ?? [])]) {
		await client.storage.peers.store(peer);
	}
}

/**
 * Fails every fetch of a channel the session no longer holds a complete copy of.
 *
 * @param client - The session.
 * @param channel - The channel.
 * @param failure - `unresolvable` when the session can no longer resolve the channel, otherwise the
 * error Telegram answers the fetch with.
 */
export function failChannelFetch(
	client: TelegramClient,
	channel: tl.RawChannel,
	failure: 'unresolvable' | tl.RpcError,
): void {
	vi.spyOn(client, 'resolvePeer').mockImplementation(async (peerId) => {
		if (failure === 'unresolvable') {
			throw new MtPeerNotFoundError(`Peer ${String(peerId)} is not found in local cache`);
		}

		return {
			_: 'inputPeerChannel',
			channelId: channel.id,
			accessHash: channel.accessHash ?? Long.ZERO,
		};
	});
	vi.spyOn(client, 'call').mockRejectedValue(
		failure === 'unresolvable' ? new Error('No call expected') : failure,
	);
}

/**
 * A dialog of the session, as `iterDialogs` yields it.
 *
 * @param peer - The dialog's peer.
 * @param chats - The chats the dialog list carried.
 * @param users - The users the dialog list carried.
 * @param topMessage - The id of the dialog's newest message, 0 for none.
 * @returns The dialog.
 */
export function dialogOf(
	peer: tl.TypePeer,
	chats: tl.TypeChat[] = [],
	users: tl.TypeUser[] = [],
	topMessage = 0,
): Dialog {
	return new Dialog(
		{
			_: 'dialog',
			peer,
			topMessage,
			readInboxMaxId: 0,
			readOutboxMaxId: 0,
			unreadCount: 0,
			unreadMentionsCount: 0,
			unreadReactionsCount: 0,
			unreadPollVotesCount: 0,
			notifySettings: { _: 'peerNotifySettings' },
		},
		PeersIndex.from({ chats, users }),
		new Map(),
	);
}

/**
 * Stands in for `iterDialogs` over a fixed list.
 *
 * @param dialogs - The dialogs to yield.
 * @returns An iterator over them.
 */
export async function* iterate<T>(dialogs: readonly T[]): AsyncIterableIterator<T> {
	yield* dialogs;
}

/**
 * Stands in for a download of `size` bytes, in chunks the way mtcute yields them.
 *
 * @param size - The file size.
 * @returns An iterator over the chunks.
 */
export async function* bytesOf(
	size: number,
	chunkSize = 16_384,
): AsyncIterableIterator<Uint8Array> {
	for (let offset = 0; offset < size; offset += chunkSize) {
		yield new Uint8Array(Math.min(chunkSize, size - offset));
	}
}
