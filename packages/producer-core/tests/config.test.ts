import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import {
	ChatListSchema,
	IngestConfigSchema,
	configFields,
	createFilterConfigSchema,
	loadConfig,
} from '../src/config';
import initLogger from '../src/init-logger';

const ConfigSchema = z.object({
	token: z.string().min(1).meta({ env: 'EXAMPLE_TOKEN' }),
	data_dir: z.string().default('/data').meta({ env: 'DATA_DIR' }),
	ingest: IngestConfigSchema,
	filter: createFilterConfigSchema({ type: z.enum(['dm', 'guild']), guildId: z.string() }),
});

const REQUIRED_ENV = {
	EXAMPLE_TOKEN: 'env-token',
	INGEST_URL: 'wss://ingest.example/example/v1',
	INGEST_API_KEY: 'tc_env_key',
};

const warnings: unknown[] = [];
let directory: string;
let files = 0;

function configFile(toml: string): string {
	const path = join(directory, `config-${++files}.toml`);

	writeFileSync(path, toml);

	return path;
}

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), 'producer-config-'));
	initLogger({
		silent: true,
		drain: ({ event: { level, message } }) => {
			if (level === 'warn') {
				warnings.push(message);
			}
		},
	});
});

afterEach(() => {
	warnings.length = 0;
});

afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe('loadConfig', () => {
	it('runs from the environment alone when there is no file', () => {
		const config = loadConfig(ConfigSchema, {
			section: 'example',
			path: join(directory, 'missing.toml'),
			env: REQUIRED_ENV,
		});

		expect(config).toEqual({
			token: 'env-token',
			data_dir: '/data',
			ingest: { url: REQUIRED_ENV.INGEST_URL, api_key: 'tc_env_key', window: 500 },
			filter: { rules: undefined, fallback: 'allow' },
		});
	});

	it('takes each setting from the file, over the default', () => {
		const path = configFile(`
			[example]
			token = "file-token"
			data_dir = "/var/example"

			[example.ingest]
			url = "wss://file.example/example/v1"
			api_key = "tc_file_key"
			window = 20
		`);

		expect(loadConfig(ConfigSchema, { section: 'example', path, env: {} })).toMatchObject({
			token: 'file-token',
			data_dir: '/var/example',
			ingest: { url: 'wss://file.example/example/v1', api_key: 'tc_file_key', window: 20 },
		});
	});

	it('lets an environment variable override the file', () => {
		const path = configFile(`
			[example]
			token = "file-token"

			[example.ingest]
			url = "wss://file.example/example/v1"
			api_key = "tc_file_key"
			window = 20
		`);

		const config = loadConfig(ConfigSchema, {
			section: 'example',
			path,
			env: { INGEST_WINDOW: '7', DATA_DIR: '/env/data' },
		});

		expect(config).toMatchObject({
			token: 'file-token',
			data_dir: '/env/data',
			ingest: { api_key: 'tc_file_key', window: 7 },
		});
	});

	it('reads only its own table', () => {
		const path = configFile(`
			[other]
			token = "not-mine"

			[example]
			token = "mine"
		`);

		const config = loadConfig(ConfigSchema, {
			section: 'example',
			path,
			env: { INGEST_URL: REQUIRED_ENV.INGEST_URL, INGEST_API_KEY: 'tc_env_key' },
		});

		expect(config.token).toBe('mine');
		expect(warnings).toEqual([]);
	});

	it('reads filter rules as a TOML array of tables the same as FILTER_RULES JSON', () => {
		const path = configFile(`
			[example.filter]
			default = "deny"

			[[example.filter.rules]]
			action = "allow"
			guildId = ["1", "2"]

			[[example.filter.rules]]
			action = "deny"
			type = "dm"
		`);

		const fromFile = loadConfig(ConfigSchema, { section: 'example', path, env: REQUIRED_ENV });
		const fromEnv = loadConfig(ConfigSchema, {
			section: 'example',
			path: join(directory, 'missing.toml'),
			env: {
				...REQUIRED_ENV,
				FILTER_DEFAULT: 'deny',
				FILTER_RULES:
					'[{"action":"allow","guildId":["1","2"]},{"action":"deny","type":"dm"}]',
			},
		});

		expect(fromFile.filter).toEqual({
			rules: [
				{ action: 'allow', match: { guildId: ['1', '2'] } },
				{ action: 'deny', match: { type: ['dm'] } },
			],
			fallback: 'deny',
		});
		expect(fromEnv.filter).toEqual(fromFile.filter);
	});

	it('warns once per unknown key and keeps the known ones', async () => {
		const path = configFile(`
			[example]
			tokn = "typo"
			token = "file-token"

			[example.ingest]
			windw = 3
		`);

		const config = loadConfig(ConfigSchema, { section: 'example', path, env: REQUIRED_ENV });

		expect(config.token).toBe('env-token');
		await vi.waitFor(() => expect(warnings).toHaveLength(2));
		expect(warnings).toEqual([
			`Ignoring the unknown key example.tokn in ${path}`,
			`Ignoring the unknown key example.ingest.windw in ${path}`,
		]);
	});

	it('names the TOML path and the variable of every missing or invalid setting', () => {
		const path = configFile(`
			[example.ingest]
			url = "https://not-a-websocket.example"
			window = -1

			[[example.filter.rules]]
			action = "deny"
			channelId = "1"
		`);

		expect(() => loadConfig(ConfigSchema, { section: 'example', path, env: {} })).toThrow(
			new RegExp(
				[
					`^Missing or invalid settings in ${path.replaceAll('\\', '\\\\')} or the environment:`,
					'  example\\.token \\(EXAMPLE_TOKEN\\): .+',
					'  example\\.ingest\\.url \\(INGEST_URL\\): .+',
					'  example\\.ingest\\.api_key \\(INGEST_API_KEY\\): .+',
					'  example\\.ingest\\.window \\(INGEST_WINDOW\\): .+',
					'  example\\.filter\\.rules\\[0\\] \\(FILTER_RULES\\): .+',
				].join('\n'),
			),
		);
	});

	it('names the file it cannot parse', () => {
		const path = configFile('[example\ntoken = ');

		expect(() => loadConfig(ConfigSchema, { section: 'example', path, env: {} })).toThrow(
			`Failed to read ${path}: Invalid TOML document`,
		);
	});
});

describe('configFields', () => {
	it('lists every setting with its TOML path and variable', () => {
		expect(
			configFields(ConfigSchema).map(({ path, meta }) => [path.join('.'), meta.env]),
		).toEqual([
			['token', 'EXAMPLE_TOKEN'],
			['data_dir', 'DATA_DIR'],
			['ingest.url', 'INGEST_URL'],
			['ingest.api_key', 'INGEST_API_KEY'],
			['ingest.window', 'INGEST_WINDOW'],
			['filter.rules', 'FILTER_RULES'],
			['filter.default', 'FILTER_DEFAULT'],
		]);
	});
});

describe('ChatListSchema', () => {
	it('refuses a chat id filter rules could not match', () => {
		const chat = { id: 'general', name: 'General', type: 'guild' };

		expect(ChatListSchema.safeParse({ platform: 'discord', chats: [chat] }).success).toBe(
			false,
		);
	});
});
