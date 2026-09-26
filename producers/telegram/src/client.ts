import { SqliteStorage, TelegramClient, type tl } from '@mtcute/node';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

export const SESSION_FILE = 'telegram.session';

type TelegramClientOptions = {
	apiId: number;
	apiHash: string;
	/** Where the SQLite session lives, so a restart resumes the login, peer cache and update state. */
	dataDir: string;
	/** Receives the channel differences mtcute cannot replay as individual updates. */
	onChannelTooLong?: (
		channelId: number,
		difference: tl.updates.RawChannelDifferenceTooLong,
	) => void;
};

/**
 * Creates the mtcute client on a SQLite session under the data directory. Gap
 * recovery is mtcute's: it expands short updates, fetches differences for gaps
 * and `updatesTooLong`, and catches up on what was missed while stopped.
 *
 * @param options - API credentials, the data directory and the too-long handler.
 * @returns The client, not yet connected.
 */
function createTelegramClient({
	apiId,
	apiHash,
	dataDir,
	onChannelTooLong,
}: TelegramClientOptions): TelegramClient {
	mkdirSync(dataDir, { recursive: true });

	return new TelegramClient({
		apiId,
		apiHash,
		storage: new SqliteStorage(join(dataDir, SESSION_FILE)),
		updates: { catchUp: true, onChannelTooLong },
	});
}

export default createTelegramClient;
