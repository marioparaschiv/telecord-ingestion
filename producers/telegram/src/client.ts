import { SqliteStorage, TelegramClient, networkMiddlewares, type tl } from '@mtcute/node';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { watchCalls, type SessionSignals } from './session';
import bridgeMtcuteLogs from './mtcute-logs';

export const SESSION_FILE = 'telegram.session';

type ProducerHandlers = SessionSignals & {
	/** Receives the channel differences mtcute cannot replay as individual updates. */
	onChannelTooLong?: (
		channelId: number,
		difference: tl.updates.RawChannelDifferenceTooLong,
	) => void;
};

type TelegramClientOptions = {
	apiId: number;
	apiHash: string;
	/** Where the SQLite session lives, so a restart resumes the login, peer cache and update state. */
	dataDir: string;
	/**
	 * The handlers of the producer the session feeds. Without them the session
	 * neither receives updates nor moves their stored state, so the producer's
	 * next run still catches up on everything.
	 */
	producer?: ProducerHandlers;
};

/**
 * Creates the mtcute client on a SQLite session under the data directory. Gap
 * recovery is mtcute's: it expands short updates, fetches differences for gaps
 * and `updatesTooLong`, and catches up on what was missed while stopped.
 *
 * @param options - API credentials, the data directory and, for a producing session, the
 * handlers for too-long channel differences, a refused authorization and skipped updates.
 * @returns The client, not yet connected.
 */
function createTelegramClient({
	apiId,
	apiHash,
	dataDir,
	producer,
}: TelegramClientOptions): TelegramClient {
	mkdirSync(dataDir, { recursive: true });

	const client = new TelegramClient({
		apiId,
		apiHash,
		storage: new SqliteStorage(join(dataDir, SESSION_FILE)),
		updates: producer ? { catchUp: true, onChannelTooLong: producer.onChannelTooLong } : false,
		network: {
			middlewares: [
				...(producer ? [watchCalls(producer)] : []),
				...networkMiddlewares.basic(),
			],
		},
		initConnectionOptions: {
			deviceModel:
				`Telecord Integration ${process.env.NODE_ENV === 'development' ? '(Development)' : ''}`.trim(),
			appVersion: '1.0.0',
			systemVersion: '1.0.0',
		},
	});

	bridgeMtcuteLogs(client.log.mgr);

	return client;
}

export default createTelegramClient;
