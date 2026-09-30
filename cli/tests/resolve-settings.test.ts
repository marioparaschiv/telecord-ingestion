import { describe, expect, it } from 'vitest';

import { resolveSettings } from '../src/resolve-settings';
import { platformSettings } from '../src/settings';
import PLATFORMS from '../src/platforms';

const discord = platformSettings(PLATFORMS[1]);

const COMPLETE = {
	TELECORD_DISCORD_TOKEN: 'token',
	TELECORD_DISCORD_INGEST_API_KEY: 'key',
};

function keysOf(values: Awaited<ReturnType<typeof resolveSettings>>) {
	return Object.fromEntries(values.map(({ setting, value }) => [setting.key, value]));
}

describe('resolveSettings', () => {
	it('takes flags over variables, without prompting when nothing is missing', async () => {
		const values = await resolveSettings(discord, {
			flags: { 'discord.ingest.url': 'wss://flag/discord/v1' },
			env: {
				...COMPLETE,
				TELECORD_DISCORD_INGEST_URL: 'wss://env/discord/v1',
				TELECORD_DISCORD_INGEST_WINDOW: '20',
			},
			current: {},
			prompt: undefined,
		});

		expect(keysOf(values)).toEqual({
			'discord.token': 'token',
			'discord.ingest.url': 'wss://flag/discord/v1',
			'discord.ingest.api_key': 'key',
			'discord.ingest.window': 20,
		});
	});

	it('never reads a secret from a flag', async () => {
		await expect(
			resolveSettings(discord, {
				flags: { 'discord.token': 'leaked', 'discord.ingest.url': 'wss://x/discord/v1' },
				env: { TELECORD_DISCORD_INGEST_API_KEY: 'key' },
				current: {},
				prompt: undefined,
			}),
		).rejects.toThrow(
			'Missing required settings:\n  discord.token: set TELECORD_DISCORD_TOKEN',
		);
	});

	it('names the flag or variable of every missing setting when it cannot prompt', async () => {
		await expect(
			resolveSettings(discord, { flags: {}, env: {}, current: {}, prompt: undefined }),
		).rejects.toThrow(
			'Missing required settings:\n  discord.token: set TELECORD_DISCORD_TOKEN\n  discord.ingest.api_key: set TELECORD_DISCORD_INGEST_API_KEY',
		);
	});

	it('writes the hosted ingest URL of a new install when it cannot prompt', async () => {
		const values = await resolveSettings(discord, {
			flags: {},
			env: COMPLETE,
			current: {},
			prompt: undefined,
		});

		expect(keysOf(values)).toEqual({
			'discord.token': 'token',
			'discord.ingest.api_key': 'key',
			'discord.ingest.url': 'wss://ingest.telecord.app/discord/v1',
		});
	});

	it('offers the hosted ingest URL when asking', async () => {
		const offered: (string | undefined)[] = [];

		await resolveSettings(discord, {
			flags: {},
			env: COMPLETE,
			current: {},
			prompt: async (setting) => {
				offered.push(setting.suggestion);

				return setting.suggestion;
			},
		});

		expect(offered).toEqual(['wss://ingest.telecord.app/discord/v1']);
	});

	it('keeps what config.toml has and asks only for what is new', async () => {
		const asked: string[] = [];
		const values = await resolveSettings(discord, {
			flags: {},
			env: {},
			current: { discord: { token: 'old', ingest: { url: 'wss://old/discord/v1' } } },
			prompt: async (setting) => {
				asked.push(setting.key);

				return 'answer';
			},
		});

		expect(asked).toEqual(['discord.ingest.api_key']);
		expect(keysOf(values)).toEqual({ 'discord.ingest.api_key': 'answer' });
	});

	it('rejects an invalid value, naming the setting', async () => {
		await expect(
			resolveSettings(discord, {
				flags: { 'discord.ingest.window': 'many' },
				env: COMPLETE,
				current: {},
				prompt: undefined,
			}),
		).rejects.toThrow('Invalid discord.ingest.window');
	});
});
