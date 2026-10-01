import { describe, expect, it } from 'vitest';

import { configFields, loadConfig } from '@telecord/producer-core/config';

import {
	TELEGRAM_CONFIG_SECTION,
	TelegramConfigSchema,
	TelegramSessionConfigSchema,
} from '../src/config';

const MISSING_FILE = 'missing/config.toml';

const SESSION_ENV = { TELEGRAM_API_ID: '12345', TELEGRAM_API_HASH: 'hash' };

describe('the Telegram config', () => {
	it('keeps every environment variable the producer read before config.toml', () => {
		expect(
			Object.fromEntries(
				configFields(TelegramConfigSchema).map(({ path, meta }) => [
					path.join('.'),
					meta.env,
				]),
			),
		).toEqual({
			api_id: 'TELEGRAM_API_ID',
			api_hash: 'TELEGRAM_API_HASH',
			bot_token: 'TELEGRAM_BOT_TOKEN',
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
			loadConfig(TelegramConfigSchema, {
				section: TELEGRAM_CONFIG_SECTION,
				path: MISSING_FILE,
				env: SESSION_ENV,
			}),
		).toThrow(/telegram\.ingest\.api_key \(INGEST_API_KEY\)/);
	});

	it('logs in and lists chats without the ingest settings', () => {
		expect(
			loadConfig(TelegramSessionConfigSchema, {
				section: TELEGRAM_CONFIG_SECTION,
				path: MISSING_FILE,
				env: SESSION_ENV,
			}),
		).toMatchObject({ api_id: 12_345, api_hash: 'hash', data_dir: '/data', ingest: {} });
	});
});
