import { tl, type TelegramClient } from '@mtcute/node';

import {
	TELEGRAM_ROUTE,
	TELEGRAM_VERSION_PARAM,
	TelegramOpcode,
} from '@telecord/ingest-client/telegram';
import { IngestConnection, type Filter } from '@telecord/producer-core';

import { createTelegramRequests } from './requests';
import { createTelegramSnapshot } from './snapshot';
import { createUpdateForwarder } from './updates';

type TelegramProducerOptions = {
	client: TelegramClient;
	filter: Filter;
	url: string;
	apiKey: string;
	onFatal: (reason: string) => void;
};

/**
 * Wires a session to the ingest server: its updates become `UPDATE` frames on
 * the connection, and the connection's requests are answered from it. The
 * route is declared at mtcute's TL layer, the layer every payload is
 * serialized at.
 *
 * @param options - The session, filter rules, server and fatal-refusal handler.
 * @returns The connection, not yet started, and the update handlers to register on the client.
 */
export function createTelegramProducer({
	client,
	filter,
	url,
	apiKey,
	onFatal,
}: TelegramProducerOptions) {
	const connection = new IngestConnection({
		url,
		apiKey,
		route: TELEGRAM_ROUTE,
		versionParam: TELEGRAM_VERSION_PARAM,
		version: tl.LAYER,
		requests: {
			...createTelegramRequests(client, filter),
			[TelegramOpcode.CHATS_FETCH]: createTelegramSnapshot(client, filter),
		},
		onFatal,
	});

	const updates = createUpdateForwarder({
		client,
		filter,
		send: (payload) => connection.send(TelegramOpcode.UPDATE, payload),
	});

	return { connection, updates };
}
