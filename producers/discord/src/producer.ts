import type { Client } from 'discord.js-selfbot-v13';
import { z } from 'zod';

import {
	DISCORD_ROUTE,
	DISCORD_VERSION_PARAM,
	DiscordOpcode,
} from '@telecord/ingest-client/discord';
import { IngestConnection, type Filter } from '@telecord/producer-core';

import { createDispatchForwarder } from './dispatches';
import { createDiscordRequests } from './requests';
import { createDiscordSnapshot } from './snapshot';

// discord.js connects with `ws.version` but leaves it out of its typings, so it is read through a schema.
const GatewayOptionsSchema = z.object({ version: z.number().int().positive() });

type DiscordProducerOptions = {
	client: Client;
	filter: Filter;
	url: string;
	apiKey: string;
	onFatal: (reason: string) => void;
};

/**
 * Wires a client to the ingest server: its dispatches become frames on the
 * connection, and the connection's requests are answered from it. The route
 * is declared at the gateway API version the client connects with, which
 * shapes every forwarded dispatch.
 *
 * @param options - The client, filter rules, server and fatal-refusal handler.
 * @returns The connection, not yet started, and the handler for the client's `raw` event.
 * @throws When the client declares no gateway API version.
 */
export function createDiscordProducer({
	client,
	filter,
	url,
	apiKey,
	onFatal,
}: DiscordProducerOptions) {
	const { version } = GatewayOptionsSchema.parse(client.options.ws);
	const connection = new IngestConnection({
		url,
		apiKey,
		route: DISCORD_ROUTE,
		versionParam: DISCORD_VERSION_PARAM,
		version,
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

	return { connection, dispatches };
}
