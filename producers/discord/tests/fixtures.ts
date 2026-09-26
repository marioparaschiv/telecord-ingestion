import { Client } from 'discord.js-selfbot-v13';
import { vi, type Mock } from 'vitest';
import { z } from 'zod';

import {
	FakeIngestServer,
	loadVectors,
	type FakeProducerSocket,
	type VectorBindings,
} from '@telecord/producer-core/testing';
import discordVectors from '@telecord/ingest-client/vectors/discord.json' with { type: 'json' };
import type { IngestEnvelope } from '@telecord/ingest-client';
import { IngestOpcode } from '@telecord/ingest-client';
import type { Filter } from '@telecord/producer-core';

import { FakeDiscordGateway, type GatewaySession } from './fake-gateway';
import { createDiscordProducer } from '../src/producer';
import { DiscordEnvSchema } from '../src/env';

export const bindings: VectorBindings = {
	min: 9,
	max: 10,
	key: 'tc_test_key',
	foreignKey: 'tc_foreign_key',
	unboundKey: 'tc_unbound_key',
	parkLimit: 10_000,
};

export const vectors = loadVectors(discordVectors, bindings);

export const GUILD_ID = '1100000000000000001';
export const GENERAL_CHANNEL_ID = '1100000000000000002';
export const NOTES_CHANNEL_ID = '1100000000000000003';
export const DM_CHANNEL_ID = '1100000000000000500';

export const SELF = {
	id: '1100000000000000200',
	username: 'ada',
	discriminator: '0',
	global_name: 'Ada',
	avatar: null,
};

export const FRIEND = {
	id: '1100000000000000201',
	username: 'charles',
	discriminator: '0',
	global_name: 'Charles',
	avatar: null,
};

/** The filter a producer starts with when no rules are configured. */
export const DEFAULT_FILTER: Filter = {
	rules: DiscordEnvSchema.shape.FILTER_RULES.parse(undefined),
	fallback: DiscordEnvSchema.shape.FILTER_DEFAULT.parse(undefined),
};

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

const VectorGuildsSchema = z.object({
	guilds: z.array(z.looseObject({ self_member: z.looseObject({}) })),
});

/** The guild of the `request/chats-fetch` vector, as the gateway announces it in `GUILD_CREATE`. */
export function guildCreate(): Record<string, unknown> {
	const snapshot = vector('request/chats-fetch');
	const [first] = snapshot.kind === 'request' ? snapshot.reply : [];
	const [guild] = VectorGuildsSchema.parse(first?.d).guilds;

	if (!guild) {
		throw new Error('request/chats-fetch carries no guild');
	}

	const { self_member: selfMember, ...rest } = guild;

	return { ...rest, members: [selfMember] };
}

export const DM_CHANNEL = {
	id: DM_CHANNEL_ID,
	type: 1,
	recipients: [FRIEND],
	last_message_id: null,
};

type RestHandler = (url: URL, init: RequestInit | undefined) => unknown;

/** A client logged in to a fake gateway and producing to a fake ingest server. */
export type DiscordHarness = {
	client: Client;
	gateway: GatewaySession;
	socket: FakeProducerSocket;
	producer: ReturnType<typeof createDiscordProducer>;
	/** Stands in for the library's HTTP client; every REST call goes through it. */
	rest: Mock<typeof fetch>;
	/** Answers for REST routes, keyed by `METHOD /path`. */
	routes: Map<string, RestHandler>;
	/** The frames forwarded while the client logged in, already acknowledged. */
	backlog: IngestEnvelope[];
	close: () => Promise<void>;
};

/**
 * Logs a client in to a local gateway that announces the vectors' guild and a
 * DM, starts its producer against a local ingest server and greets it.
 *
 * @param filter - The producer's filter rules.
 * @returns The running harness.
 */
export async function startDiscord(filter: Filter = DEFAULT_FILTER): Promise<DiscordHarness> {
	const gateway = await FakeDiscordGateway.start();
	const ingest = await FakeIngestServer.start();
	const client = new Client();
	const routes = new Map<string, RestHandler>([
		['GET /api/v9/gateway', () => ({ url: gateway.url })],
	]);
	const rest = vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const handler = routes.get(`${init?.method ?? 'GET'} ${url.pathname}`);
		const body = handler ? handler(url, init) : { message: 'Unknown route', code: 0 };

		return new Response(JSON.stringify(body), {
			status: handler ? 200 : 404,
			headers: { 'content-type': 'application/json' },
		});
	});

	client.rest.fetch = rest;

	const producer = createDiscordProducer({
		client,
		filter,
		url: ingest.url,
		apiKey: bindings.key,
		onFatal: (reason) => {
			throw new Error(`Unexpected fatal refusal: ${reason}`);
		},
	});

	client.on('raw', (packet) => producer.dispatches.onPacket(packet));

	const ready = new Promise((resolve) => client.once('ready', resolve));
	const login = client.login('test.token.value');
	const session = await gateway.nextSession();

	session.dispatch('READY', {
		user: SELF,
		guilds: [{ id: GUILD_ID, unavailable: true }],
		private_channels: [DM_CHANNEL],
		relationships: [],
		session_id: 'session',
		resume_gateway_url: gateway.url,
	});
	session.dispatch('GUILD_CREATE', guildCreate());

	await ready;
	await login;

	producer.connection.start();

	const socket = await ingest.nextConnection();
	const backlog: IngestEnvelope[] = [];

	socket.hello();
	socket.send(IngestOpcode.PING);

	for (let frame = await socket.nextFrame(); frame.op !== IngestOpcode.PONG;) {
		backlog.push(frame);
		socket.send(IngestOpcode.ACK, null, frame.nonce);
		frame = await socket.nextFrame();
	}

	return {
		client,
		gateway: session,
		socket,
		producer,
		rest,
		routes,
		backlog,
		async close() {
			producer.connection.stop();
			client.destroy();
			await ingest.close();
			await gateway.close();
		},
	};
}
