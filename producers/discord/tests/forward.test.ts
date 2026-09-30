import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { isAllowed, resolveFilter, type Filter } from '@telecord/producer-core';
import { loadConfig } from '@telecord/producer-core/config';

import { DISCORD_CONFIG_SECTION, DiscordConfigSchema } from '../src/config';
import { DISCORD_FORWARD, type DiscordFilterSubject } from '../src/filter';

const ENV = {
	DISCORD_TOKEN: 'token',
	INGEST_URL: 'wss://ingest.example/discord/v1',
	INGEST_API_KEY: 'tc_key',
};

const HIDDEN_GUILD = '123456789012345678';
const OTHER_GUILD = '223456789012345678';

const HIDDEN_GENERAL: DiscordFilterSubject = {
	type: 'guild',
	guildId: HIDDEN_GUILD,
	channelId: '323456789012345678',
};
const HIDDEN_ANNOUNCEMENTS: DiscordFilterSubject = {
	type: 'guild',
	guildId: HIDDEN_GUILD,
	channelId: '423456789012345678',
};
const OTHER_GENERAL: DiscordFilterSubject = {
	type: 'guild',
	guildId: OTHER_GUILD,
	channelId: '523456789012345678',
};
const OTHER_OFFTOPIC: DiscordFilterSubject = {
	type: 'guild',
	guildId: OTHER_GUILD,
	channelId: '623456789012345678',
};
const FRIEND_DM: DiscordFilterSubject = { type: 'dm', channelId: '723456789012345678' };
const GROUP_DM: DiscordFilterSubject = { type: 'group_dm', channelId: '823456789012345678' };

const SUBJECTS = [
	HIDDEN_GENERAL,
	{ ...HIDDEN_GENERAL, event: 'MESSAGE_CREATE' },
	HIDDEN_ANNOUNCEMENTS,
	OTHER_GENERAL,
	OTHER_OFFTOPIC,
	FRIEND_DM,
	GROUP_DM,
] satisfies DiscordFilterSubject[];

let directory: string;
let files = 0;

function filterOf(toml: string, env: NodeJS.ProcessEnv = {}): Filter {
	const path = join(directory, `config-${++files}.toml`);

	writeFileSync(path, toml);

	const config = loadConfig(DiscordConfigSchema, {
		section: DISCORD_CONFIG_SECTION,
		path,
		env: { ...ENV, ...env },
	});

	return resolveFilter(config, DISCORD_FORWARD);
}

function allowed(filter: Filter): DiscordFilterSubject[] {
	return SUBJECTS.filter((subject) => isAllowed(filter, subject));
}

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), 'discord-forward-'));
});

afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe('the Discord forward table', () => {
	it('hides one server and keeps DMs hidden like the README recipe', () => {
		const recipe = filterOf('', {
			FILTER_RULES: `[{"action":"deny","type":["dm","group_dm"]},{"action":"deny","guildId":"${HIDDEN_GUILD}"}]`,
		});
		const forward = filterOf(`
			[discord.forward]
			deny = [{ guild = "${HIDDEN_GUILD}", name = "Hidden" }]
		`);

		expect(allowed(forward)).toEqual([OTHER_GENERAL, OTHER_OFFTOPIC]);
		expect(allowed(forward)).toEqual(allowed(recipe));
	});

	it('lets a channel entry override its server entry either way', () => {
		const shareOneChannel = filterOf(`
			[discord.forward]
			allow = [{ channel = "${HIDDEN_ANNOUNCEMENTS.channelId}", name = "#announcements" }]
			deny = [{ guild = "${HIDDEN_GUILD}", name = "Hidden" }]
		`);
		const hideOneChannel = filterOf(`
			[discord.forward]
			default = "deny"
			allow = [{ guild = "${OTHER_GUILD}", name = "Other" }]
			deny = [{ channel = "${OTHER_OFFTOPIC.channelId}", name = "#off-topic" }]
		`);

		expect(allowed(shareOneChannel)).toEqual([
			HIDDEN_ANNOUNCEMENTS,
			OTHER_GENERAL,
			OTHER_OFFTOPIC,
		]);
		expect(allowed(hideOneChannel)).toEqual([OTHER_GENERAL]);
	});

	it('keeps DMs private under default = "allow" unless one is listed in allow', () => {
		const filter = filterOf(`
			[discord.forward]
			default = "allow"
			allow = [{ channel = "${FRIEND_DM.channelId}", name = "Friend" }]
		`);

		expect(isAllowed(filter, FRIEND_DM)).toBe(true);
		expect(isAllowed(filter, GROUP_DM)).toBe(false);
		expect(isAllowed(filter, OTHER_GENERAL)).toBe(true);
	});

	it('shares DMs and group DMs with dms = true', () => {
		const filter = filterOf(`
			[discord.forward]
			default = "deny"
			dms = true
		`);

		expect(allowed(filter)).toEqual([FRIEND_DM, GROUP_DM]);
	});

	it('tells a server from a channel with the same id', () => {
		expect(() =>
			filterOf(`
				[discord.forward]
				allow = [{ guild = "${HIDDEN_GUILD}" }]
				deny = [{ channel = "${HIDDEN_GUILD}" }]
			`),
		).not.toThrow();
		expect(() =>
			filterOf(`
				[discord.forward]
				allow = [{ guild = "${HIDDEN_GUILD}" }]
				deny = [{ guild = "${HIDDEN_GUILD}" }]
			`),
		).toThrow(
			`discord.forward.deny[0] (FORWARD_DENY): ${HIDDEN_GUILD} is listed in both forward.allow and forward.deny`,
		);
	});

	it('refuses an entry naming both a server and a channel', () => {
		expect(() =>
			filterOf(`
				[discord.forward]
				allow = [{ guild = "${HIDDEN_GUILD}", channel = "${HIDDEN_GENERAL.channelId}" }]
			`),
		).toThrow(/discord\.forward\.allow\[0\] \(FORWARD_ALLOW\)/);
	});
});
