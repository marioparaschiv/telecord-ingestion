import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isAllowed, resolveFilter, type Filter } from '@telecord/producer-core';
import { loadConfig } from '@telecord/producer-core/config';

import { TELEGRAM_CONFIG_SECTION, TelegramConfigSchema } from '../src/config';
import { TELEGRAM_FORWARD, type TelegramFilterSubject } from '../src/filter';

const ENV = {
	TELEGRAM_API_ID: '12345',
	TELEGRAM_API_HASH: 'hash',
	INGEST_URL: 'wss://ingest.example/telegram/v1',
	INGEST_API_KEY: 'tc_key',
};

const NEWS: TelegramFilterSubject = { peerType: 'channel', peerId: '-1001234567890' };
const OTHER_CHANNEL: TelegramFilterSubject = { peerType: 'channel', peerId: '-1009876543210' };
const CHATTER: TelegramFilterSubject = { peerType: 'group', peerId: '-123456789' };
const FAMILY: TelegramFilterSubject = { peerType: 'group', peerId: '-987654321' };
const FRIEND: TelegramFilterSubject = { peerType: 'user', peerId: '777000123' };
const STRANGER: TelegramFilterSubject = { peerType: 'user', peerId: '424242424' };

const SUBJECTS = [
	NEWS,
	{ ...NEWS, update: 'updateNewChannelMessage' },
	OTHER_CHANNEL,
	CHATTER,
	FAMILY,
	FRIEND,
	STRANGER,
] satisfies TelegramFilterSubject[];

let directory: string;
let files = 0;

function filterOf(toml: string, env: NodeJS.ProcessEnv = {}): Filter {
	const path = join(directory, `config-${++files}.toml`);

	writeFileSync(path, toml);

	const config = loadConfig(TelegramConfigSchema, {
		section: TELEGRAM_CONFIG_SECTION,
		path,
		env: { ...ENV, ...env },
	});

	return resolveFilter(config, TELEGRAM_FORWARD);
}

function allowed(filter: Filter): TelegramFilterSubject[] {
	return SUBJECTS.filter((subject) => isAllowed(filter, subject));
}

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), 'telegram-forward-'));
});

afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe('the Telegram forward table', () => {
	it('shares only one channel like the README recipe', () => {
		const recipe = filterOf('', {
			FILTER_RULES: '[{"action":"allow","peerId":"-1001234567890"}]',
			FILTER_DEFAULT: 'deny',
		});
		const forward = filterOf(`
			[telegram.forward]
			default = "deny"
			allow = [{ id = "-1001234567890", name = "News" }]
		`);

		expect(allowed(forward)).toEqual([NEWS, { ...NEWS, update: 'updateNewChannelMessage' }]);
		expect(allowed(forward)).toEqual(allowed(recipe));
	});

	it('hides one group and keeps DMs hidden like the README recipe', () => {
		const recipe = filterOf('', {
			FILTER_RULES:
				'[{"action":"deny","peerType":"user"},{"action":"deny","peerId":"-123456789"}]',
		});
		const forward = filterOf(`
			[telegram.forward]
			deny = [{ id = "-123456789", name = "Chatter" }]
		`);

		expect(allowed(forward)).toEqual([
			NEWS,
			{ ...NEWS, update: 'updateNewChannelMessage' },
			OTHER_CHANNEL,
			FAMILY,
		]);
		expect(allowed(forward)).toEqual(allowed(recipe));
	});

	it('keeps DMs private under default = "allow" unless one is listed in allow', () => {
		const filter = filterOf(`
			[telegram.forward]
			default = "allow"
			allow = [{ id = "777000123", name = "Friend" }]
		`);

		expect(isAllowed(filter, FRIEND)).toBe(true);
		expect(isAllowed(filter, STRANGER)).toBe(false);
		expect(isAllowed(filter, FAMILY)).toBe(true);
	});

	it('shares every DM with dms = true except one listed in deny', () => {
		const filter = filterOf(`
			[telegram.forward]
			default = "deny"
			dms = true
			deny = [{ id = "424242424" }]
		`);

		expect(allowed(filter)).toEqual([FRIEND]);
	});

	it('refuses an entry that is not a peer', () => {
		expect(() =>
			filterOf(`
				[telegram.forward]
				allow = [{ guild = "123456789012345678" }]
			`),
		).toThrow(/telegram\.forward\.allow\[0\] \(FORWARD_ALLOW\)/);
	});
});
