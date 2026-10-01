import { tl, type TelegramClient } from '@mtcute/node';

import {
	TELEGRAM_ROUTE,
	TELEGRAM_VERSION_PARAM,
	TelegramOpcode,
} from '@telecord/ingest-client/telegram';
import { IngestConnection, type Filter, type Outbox } from '@telecord/producer-core';

import type ChatStore from './chats';

import { createTelegramRequests } from './requests';
import { createTelegramSnapshot } from './snapshot';
import { createUpdateForwarder } from './updates';
import { createSessionMonitor } from './session';
import identify from './identify';

type TelegramProducerOptions = {
	client: TelegramClient;
	filter: Filter;
	url: string;
	apiKey: string;
	/** The stream the account's updates are captured in and sent from. */
	outbox: Outbox;
	/** The chats a bot learned. Absent for a user account, which lists its dialogs and history. */
	chats?: ChatStore;
	/** The most events sent and not yet acknowledged. */
	window: number;
	/** Where files are written while `MEDIA_FETCH` downloads them. */
	downloadDir: string;
	onFatal: (reason: string) => void;
};

/**
 * Wires a session to the ingest server: its updates become `UPDATE` frames on
 * the connection, and the connection's requests are answered from it. The
 * route is declared at mtcute's TL layer, the layer every payload is
 * serialized at.
 *
 * @param options - The session, filter rules, server, outbox, a bot's learned chats, download
 * directory and fatal-refusal handler.
 * @returns The connection, not yet started, the update handlers to register on the client, and
 * the session monitor, which the connection reports the session's state from.
 */
export function createTelegramProducer({
	client,
	filter,
	url,
	apiKey,
	outbox,
	chats,
	window,
	downloadDir,
	onFatal,
}: TelegramProducerOptions) {
	const session = createSessionMonitor(client, (state) => connection.reportSessionState(state));
	let identity: Awaited<ReturnType<typeof identify>> | undefined;
	const connection = new IngestConnection({
		url,
		apiKey,
		route: TELEGRAM_ROUTE,
		versionParam: TELEGRAM_VERSION_PARAM,
		version: tl.LAYER,
		outbox,
		window,
		identify: async () => {
			// Telegram refuses getMe once the authorization is gone, so the account identifies as it
			// last did and the server still hears invalid_credentials after a reconnect.
			if (session.unauthorized && identity) {
				return { ...identity, recovered: session.recovered };
			}

			identity = await identify(client, session.recovered);

			return identity;
		},
		requests: {
			...createTelegramRequests(client, filter, downloadDir, chats),
			[TelegramOpcode.CHATS_FETCH]: createTelegramSnapshot(client, filter, chats),
		},
		onFatal,
	});

	const updates = createUpdateForwarder({
		client,
		filter,
		outbox,
		chats,
		send: (payload, capture) => connection.send(TelegramOpcode.UPDATE, payload, capture),
	});

	return { connection, updates, session };
}
