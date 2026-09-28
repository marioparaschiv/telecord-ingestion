import type { Client } from 'discord.js-selfbot-v13';
import { z } from 'zod';

import {
	DISCORD_ROUTE,
	DISCORD_VERSION_PARAM,
	DiscordOpcode,
} from '@telecord/ingest-client/discord';
import { IngestConnection, type Filter, type Outbox } from '@telecord/producer-core';

import { createDispatchForwarder } from './dispatches';
import { createDiscordRequests } from './requests';
import { createDiscordSnapshot } from './snapshot';
import { createSessionRecorder } from './session';
import identify from './identify';

// discord.js connects with `ws.version` but leaves it out of its typings, so it is read through a schema.
const GatewayOptionsSchema = z.object({ version: z.number().int().positive() });

type DiscordProducerOptions = {
	client: Client;
	filter: Filter;
	url: string;
	apiKey: string;
	/** The stream the account's dispatches are stored in and sent from. */
	outbox: Outbox;
	/** The most events sent and not yet acknowledged. */
	window: number;
	onFatal: (reason: string) => void;
};

/**
 * Wires a client to the ingest server: its dispatches become frames on the
 * connection, and the connection's requests are answered from it. The route
 * is declared at the gateway API version the client connects with, which
 * shapes every forwarded dispatch.
 *
 * The client's gateway session is kept in the outbox for the next run to
 * resume. When the client was seeded with a stored session, `IDENTIFY` says
 * whether it resumed. A seeded client turns ready only once it has resumed or
 * identified anew, so a connection started from its `ready` event knows which.
 *
 * @param options - The client, filter rules, server, outbox and fatal-refusal handler.
 * @returns The connection, not yet started, and the handler for the client's `raw` event.
 * @throws When the client declares no gateway API version.
 */
export function createDiscordProducer({
	client,
	filter,
	url,
	apiKey,
	outbox,
	window,
	onFatal,
}: DiscordProducerOptions) {
	const { version } = GatewayOptionsSchema.parse(client.options.ws);
	const recorder = createSessionRecorder(outbox, client.options.session);
	const connection = new IngestConnection({
		url,
		apiKey,
		route: DISCORD_ROUTE,
		versionParam: DISCORD_VERSION_PARAM,
		version,
		outbox,
		window,
		identify: async () => {
			const { resumed } = recorder;

			return { ...identify(client), ...(resumed !== undefined && { resumed }) };
		},
		requests: {
			...createDiscordRequests(client, filter),
			[DiscordOpcode.CHATS_FETCH]: createDiscordSnapshot(client, filter),
		},
		onFatal,
	});

	const dispatches = createDispatchForwarder({
		client,
		filter,
		send: (event, payload) => connection.send(event, payload),
	});

	return {
		connection,
		onPacket(packet: unknown): void {
			// The event is stored before the sequence that covers it, so a crash in between replays the dispatch rather than losing it.
			dispatches.onPacket(packet);
			recorder.onPacket(packet);
		},
	};
}
