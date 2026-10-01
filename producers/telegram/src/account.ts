import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import { OUTBOX_FILE, createTaggedLogger } from '@telecord/producer-core';

import type { TelegramAccountConfig } from './config';

import createTelegramClient, { SESSION_FILE } from './client';
import logIn from './login';

/** Names the user account a start without `bot_token` opens, by its id. */
const ACTIVE_USER_FILE = 'active-user';

/** Where a user account logs in before its id, and with it its directory, is known. */
const PENDING_DIR = 'pending';

/** A database opened in WAL mode keeps a write-ahead log and a shared-memory file beside it. */
const SQLITE_FILE_SUFFIXES = ['', '-wal', '-shm'];

const logger = createTaggedLogger('Telegram Account');

/** Moves a closed SQLite database, replacing one already at the destination. */
function moveDatabase(file: string, from: string, to: string): void {
	if (!existsSync(join(from, file))) {
		return;
	}

	for (const suffix of SQLITE_FILE_SUFFIXES) {
		const source = join(from, file + suffix);
		const target = join(to, file + suffix);

		// A log left beside the destination would be replayed into the database moved in.
		rmSync(target, { force: true });

		if (existsSync(source)) {
			renameSync(source, target);
		}
	}
}

function writeActiveUser(dataDir: string, userId: number): void {
	writeFileSync(join(dataDir, ACTIVE_USER_FILE), String(userId));
}

function readActiveUser(dataDir: string): string | undefined {
	const file = join(dataDir, ACTIVE_USER_FILE);

	if (!existsSync(file)) {
		return undefined;
	}

	const userId = readFileSync(file, 'utf8').trim();

	if (!/^\d+$/.test(userId)) {
		throw new Error(`Failed to read ${file}: expected a user id, got "${userId}"`);
	}

	return userId;
}

/**
 * Moves the session and outbox an older producer kept in the data directory
 * itself into the directory of the account the session is logged in as, which
 * becomes the active user. The session is moved last, so a move cut short is
 * finished by the next start.
 */
async function migrateDataDir({
	api_id,
	api_hash,
	data_dir,
}: TelegramAccountConfig): Promise<void> {
	if (!existsSync(join(data_dir, SESSION_FILE))) {
		return;
	}

	const client = createTelegramClient({ apiId: api_id, apiHash: api_hash, dataDir: data_dir });
	let userId: number | undefined;

	try {
		await client.prepare();
		userId = (await client.storage.self.fetch())?.userId;
	} finally {
		await client.destroy();
	}

	const dir = join(data_dir, userId === undefined ? PENDING_DIR : String(userId));

	mkdirSync(dir, { recursive: true });
	moveDatabase(OUTBOX_FILE, data_dir, dir);

	if (userId !== undefined) {
		writeActiveUser(data_dir, userId);
	}

	moveDatabase(SESSION_FILE, data_dir, dir);
	logger.info(`Moved the session and outbox from ${data_dir} into ${dir}`);
}

/**
 * The directory holding an account's session, outbox and learned chats. A
 * bot's is named by the id its token starts with, a user's by the id its last
 * login wrote down.
 *
 * @param config - The data directory and the account's credentials.
 * @returns The directory, which for a user account that never logged in is the pending one.
 */
export async function resolveAccountDir(config: TelegramAccountConfig): Promise<string> {
	await migrateDataDir(config);

	const { data_dir, bot_token } = config;

	if (bot_token !== undefined) {
		return join(data_dir, bot_token.slice(0, bot_token.indexOf(':')));
	}

	return join(data_dir, readActiveUser(data_dir) ?? PENDING_DIR);
}

/**
 * Logs the account in on a session of its own, closed again before this
 * returns. A user account's session is then moved under the id it logged in
 * as, which becomes the active user, so each account a data directory has
 * seen keeps its own outbox.
 *
 * @param config - The data directory and the account's credentials.
 * @returns The account's directory, and the line telling the user which account is logged in.
 * @throws When the login fails, naming the step it failed at.
 */
export async function logInAccount(
	config: TelegramAccountConfig,
): Promise<{ dir: string; line: string }> {
	const { api_id, api_hash, data_dir, bot_token } = config;
	const dir = await resolveAccountDir(config);
	const client = createTelegramClient({ apiId: api_id, apiHash: api_hash, dataDir: dir });
	let login: Awaited<ReturnType<typeof logIn>>;

	try {
		login = await logIn(client, (prompt) => client.input(prompt), bot_token);
	} finally {
		await client.destroy();
	}

	if (bot_token !== undefined) {
		return { dir, line: login.line };
	}

	const settled = join(data_dir, String(login.userId));

	if (settled !== dir) {
		mkdirSync(settled, { recursive: true });
		moveDatabase(SESSION_FILE, dir, settled);
	}

	writeActiveUser(data_dir, login.userId);

	return { dir: settled, line: login.line };
}

/**
 * The directory of the account to produce from. A user account that never
 * logged in is logged in first, prompting on the terminal.
 *
 * @param config - The data directory and the account's credentials.
 * @returns The account's directory.
 */
export async function openAccountDir(config: TelegramAccountConfig): Promise<string> {
	const dir = await resolveAccountDir(config);

	if (basename(dir) !== PENDING_DIR) {
		return dir;
	}

	const login = await logInAccount(config);

	logger.info(login.line);

	return login.dir;
}
