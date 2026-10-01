import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { TelegramClient, User, type tl } from '@mtcute/node';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { OUTBOX_FILE, Outbox } from '@telecord/producer-core';

import type { TelegramAccountConfig } from '../src/config';

import createTelegramClient, { SESSION_FILE } from '../src/client';
import { logInAccount, resolveAccountDir } from '../src/account';
import { SELF } from './fixtures';

const OTHER: tl.RawUser = { _: 'user', id: 888_000_222, firstName: 'Other' };

let dataDir: string;

function configOf(botToken?: string): TelegramAccountConfig {
	return { api_id: 1, api_hash: 'offline', data_dir: dataDir, bot_token: botToken };
}

/** The id of the account the session saved in a directory is logged in as. */
async function savedUserId(dir: string): Promise<number | undefined> {
	const client = createTelegramClient({ apiId: 1, apiHash: 'offline', dataDir: dir });

	try {
		await client.prepare();

		return (await client.storage.self.fetch())?.userId;
	} finally {
		await client.destroy();
	}
}

async function saveSession(dir: string, userId: number): Promise<void> {
	const client = createTelegramClient({ apiId: 1, apiHash: 'offline', dataDir: dir });

	try {
		await client.prepare();
		await client.storage.self.store({ userId, isBot: false, isPremium: false, usernames: [] });
	} finally {
		await client.destroy();
	}
}

/** Creates a directory's outbox and answers the stream id it generated. */
function createOutbox(dir: string): string {
	const outbox = new Outbox(join(dir, OUTBOX_FILE));

	try {
		return outbox.streamId;
	} finally {
		outbox.close();
	}
}

/** Stands in for mtcute's login: the session ends up logged in as `user` without calling Telegram. */
function logInAs(user: tl.RawUser) {
	return vi.spyOn(TelegramClient.prototype, 'start').mockImplementation(async function (
		this: TelegramClient,
	) {
		await this.prepare();
		await this.storage.self.store({
			userId: user.id,
			isBot: false,
			isPremium: false,
			usernames: [],
		});

		return new User(user);
	});
}

beforeEach(() => {
	dataDir = mkdtempSync(join(tmpdir(), 'telegram-account-'));
});

afterEach(() => {
	vi.restoreAllMocks();
	rmSync(dataDir, { recursive: true, force: true });
});

describe('resolveAccountDir', () => {
	it("names a bot's directory by the id its token starts with", async () => {
		expect(await resolveAccountDir(configOf('4242:secret'))).toBe(join(dataDir, '4242'));
	});

	it('opens the pending directory for a user account that never logged in', async () => {
		expect(await resolveAccountDir(configOf())).toBe(join(dataDir, 'pending'));
	});

	it("moves a session and outbox kept in the data directory itself under the account's id", async () => {
		await saveSession(dataDir, SELF.id);

		const streamId = createOutbox(dataDir);
		const dir = await resolveAccountDir(configOf());

		expect(dir).toBe(join(dataDir, String(SELF.id)));
		expect(existsSync(join(dataDir, SESSION_FILE))).toBe(false);
		expect(existsSync(join(dataDir, OUTBOX_FILE))).toBe(false);
		expect(await savedUserId(dir)).toBe(SELF.id);
		expect(createOutbox(dir)).toBe(streamId);
		expect(await resolveAccountDir(configOf())).toBe(dir);
	});

	it('refuses an active user file that names no user id', async () => {
		writeFileSync(join(dataDir, 'active-user'), '../elsewhere');

		await expect(resolveAccountDir(configOf())).rejects.toThrow(
			/active-user: expected a user id, got "\.\.\/elsewhere"/,
		);
	});
});

describe('logInAccount', () => {
	it('moves a user session from the pending directory under the id it logged in as', async () => {
		logInAs(SELF);

		const { dir, line } = await logInAccount(configOf());

		expect(dir).toBe(join(dataDir, String(SELF.id)));
		expect(line).toBe('Already logged in as Conformance (@conformance)');
		expect(await savedUserId(dir)).toBe(SELF.id);
		expect(existsSync(join(dataDir, 'pending', SESSION_FILE))).toBe(false);
		expect(await resolveAccountDir(configOf())).toBe(dir);
	});

	it("gives another user a directory of its own, leaving the first one's outbox where it was", async () => {
		logInAs(SELF);

		const first = await logInAccount(configOf());
		const streamId = createOutbox(first.dir);

		logInAs(OTHER);

		const second = await logInAccount(configOf());

		expect(second.dir).toBe(join(dataDir, String(OTHER.id)));
		expect(await savedUserId(second.dir)).toBe(OTHER.id);
		expect(existsSync(join(second.dir, OUTBOX_FILE))).toBe(false);
		expect(createOutbox(first.dir)).toBe(streamId);
		expect(readFileSync(join(dataDir, 'active-user'), 'utf8')).toBe(String(OTHER.id));
	});

	it('logs a bot in inside its own directory, leaving the active user as it was', async () => {
		logInAs(SELF);
		await logInAccount(configOf());

		const start = logInAs(OTHER);
		const { dir } = await logInAccount(configOf(`${OTHER.id}:secret`));

		expect(dir).toBe(join(dataDir, String(OTHER.id)));
		expect(start).toHaveBeenCalledWith({ botToken: `${OTHER.id}:secret` });
		expect(await resolveAccountDir(configOf())).toBe(join(dataDir, String(SELF.id)));
	});
});
