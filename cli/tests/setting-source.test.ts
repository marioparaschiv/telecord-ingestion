import { describe, expect, it } from 'vitest';

import { formatSettingSource, formatSettingValue, settingSource } from '../src/setting-source';
import { allSettings } from '../src/settings';

function setting(key: string) {
	const found = allSettings().find((candidate) => candidate.key === key);

	if (found === undefined) {
		throw new Error(`No setting ${key}`);
	}

	return found;
}

function show(key: string, table: Record<string, unknown>, env: Record<string, string> = {}) {
	const found = settingSource(setting(key), table, env);

	return `${formatSettingValue(setting(key), found)} | ${formatSettingSource(found)}`;
}

const TABLE = {
	discord: { token: 'secret-token', ingest: { url: 'wss://file/discord/v1', window: 10 } },
};

describe('settingSource', () => {
	it('takes the container environment over the file over the default', () => {
		expect(show('discord.ingest.url', TABLE, { INGEST_URL: 'wss://env/discord/v1' })).toBe(
			'wss://env/discord/v1 | env INGEST_URL',
		);
		expect(show('discord.ingest.url', TABLE)).toBe('wss://file/discord/v1 | file');
		expect(show('discord.ingest.window', TABLE)).toBe('10 | file');
		expect(show('discord.data_dir', TABLE)).toBe('/data | default');
	});

	it('masks secrets', () => {
		expect(show('discord.token', TABLE)).toBe('******** | file');
		expect(show('discord.ingest.api_key', TABLE, { INGEST_API_KEY: 'k' })).toBe(
			'******** | env INGEST_API_KEY',
		);
	});

	it('tells a missing required setting from an unset optional one', () => {
		expect(show('discord.ingest.api_key', TABLE)).toBe('(missing) | unset');
		expect(show('discord.forward.default', TABLE)).toBe('(unset) | unset');
	});
});
