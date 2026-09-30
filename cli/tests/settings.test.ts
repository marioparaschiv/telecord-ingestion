import { describe, expect, it } from 'vitest';

import {
	allSettings,
	platformSettings,
	settingEnv,
	settingFlag,
	toTomlValue,
} from '../src/settings';
import PLATFORMS from '../src/platforms';

function setting(key: string) {
	const found = allSettings().find((candidate) => candidate.key === key);

	if (found === undefined) {
		throw new Error(`No setting ${key}`);
	}

	return found;
}

describe('settingFlag and settingEnv', () => {
	it('derive the names from the TOML path', () => {
		expect(settingFlag(['telegram', 'ingest', 'api_key'])).toBe('--telegram-ingest-api-key');
		expect(settingEnv(['telegram', 'ingest', 'api_key'])).toBe(
			'TELECORD_TELEGRAM_INGEST_API_KEY',
		);
	});
});

describe('platformSettings', () => {
	it('lists every leaf of the producer schemas under the platform table', () => {
		const keys = PLATFORMS.flatMap(platformSettings).map(({ key }) => key);

		expect(keys).toEqual(
			expect.arrayContaining([
				'telegram.api_id',
				'telegram.api_hash',
				'telegram.data_dir',
				'telegram.ingest.url',
				'telegram.ingest.api_key',
				'telegram.ingest.window',
				'telegram.filter.rules',
				'telegram.filter.default',
				'discord.token',
				'discord.ingest.url',
				'discord.filter.rules',
			]),
		);
		expect(keys.every((key) => key.startsWith('telegram.') || key.startsWith('discord.'))).toBe(
			true,
		);
	});

	it('gives secrets a variable but no flag', () => {
		expect(setting('discord.token')).toMatchObject({
			secret: true,
			flag: undefined,
			env: 'TELECORD_DISCORD_TOKEN',
		});
		expect(setting('telegram.ingest.api_key')).toMatchObject({ secret: true, flag: undefined });
		expect(setting('telegram.api_id')).toMatchObject({
			secret: false,
			flag: '--telegram-api-id',
			env: 'TELECORD_TELEGRAM_API_ID',
		});
	});

	it('marks settings without a default as required', () => {
		expect(setting('telegram.api_id').required).toBe(true);
		expect(setting('discord.ingest.url').required).toBe(true);
		expect(setting('discord.data_dir').required).toBe(false);
		expect(setting('discord.filter.rules').required).toBe(false);
	});
});

describe('toTomlValue', () => {
	it('writes JSON the setting accepts as that value', () => {
		expect(toTomlValue(setting('telegram.api_id'), '123456')).toBe(123456);
		expect(toTomlValue(setting('discord.ingest.window'), '50')).toBe(50);
		expect(
			toTomlValue(setting('discord.filter.rules'), '[{"action":"deny","type":"dm"}]'),
		).toEqual([{ action: 'deny', type: 'dm' }]);
	});

	it('writes anything else as the string', () => {
		expect(toTomlValue(setting('telegram.api_hash'), '0123456789')).toBe('0123456789');
		expect(toTomlValue(setting('discord.filter.default'), 'deny')).toBe('deny');
		expect(toTomlValue(setting('discord.ingest.url'), 'wss://ingest.example/discord/v1')).toBe(
			'wss://ingest.example/discord/v1',
		);
	});

	it('rejects a value the setting does not accept, naming it', () => {
		expect(() => toTomlValue(setting('telegram.api_id'), 'abc')).toThrow(
			'Invalid telegram.api_id',
		);
		expect(() => toTomlValue(setting('discord.ingest.url'), 'https://x')).toThrow(
			'Invalid discord.ingest.url',
		);
		expect(() => toTomlValue(setting('discord.filter.rules'), '[{"action":"maybe"}]')).toThrow(
			'Invalid discord.filter.rules',
		);
	});
});
