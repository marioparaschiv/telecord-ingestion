import { describe, expect, it } from 'vitest';

import { configFields, loadConfig } from '@telecord/producer-core/config';

import {
	DISCORD_CONFIG_SECTION,
	DiscordConfigSchema,
	DiscordSessionConfigSchema,
} from '../src/config';

const MISSING_FILE = 'missing/config.toml';

describe('the Discord config', () => {
	it('keeps every environment variable the producer read before config.toml', () => {
		expect(
			Object.fromEntries(
				configFields(DiscordConfigSchema).map(({ path, meta }) => [
					path.join('.'),
					meta.env,
				]),
			),
		).toEqual({
			token: 'DISCORD_TOKEN',
			data_dir: 'DATA_DIR',
			'ingest.url': 'INGEST_URL',
			'ingest.api_key': 'INGEST_API_KEY',
			'ingest.window': 'INGEST_WINDOW',
			'filter.rules': 'FILTER_RULES',
			'filter.default': 'FILTER_DEFAULT',
			'forward.default': 'FORWARD_DEFAULT',
			'forward.dms': 'FORWARD_DMS',
			'forward.allow': 'FORWARD_ALLOW',
			'forward.deny': 'FORWARD_DENY',
		});
	});

	it('requires the ingest settings to produce', () => {
		expect(() =>
			loadConfig(DiscordConfigSchema, {
				section: DISCORD_CONFIG_SECTION,
				path: MISSING_FILE,
				env: { DISCORD_TOKEN: 'token' },
			}),
		).toThrow(/discord\.ingest\.url \(INGEST_URL\)/);
	});

	it('lists chats without the ingest settings', () => {
		expect(
			loadConfig(DiscordSessionConfigSchema, {
				section: DISCORD_CONFIG_SECTION,
				path: MISSING_FILE,
				env: { DISCORD_TOKEN: 'token' },
			}),
		).toMatchObject({ token: 'token', ingest: {} });
	});
});
