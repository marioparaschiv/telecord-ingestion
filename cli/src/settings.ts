import { z } from 'zod';

import { configFields, type ConfigField } from '@telecord/producer-core/config';

import PLATFORMS, { type Platform, type PlatformName } from './platforms';

/** A producer setting as the CLI takes it: its TOML key, flag and environment variable. */
export type Setting = ConfigField & {
	platform: PlatformName;
	/** The full path in `config.toml`, the platform's table first. */
	tomlPath: readonly string[];
	/** The dotted `tomlPath`, e.g. `telegram.ingest.api_key`. */
	key: string;
	/** Undefined for a secret, which a flag would leave in the shell history and process list. */
	flag: string | undefined;
	env: string;
	secret: boolean;
	/** Neither optional nor defaulted, so setup cannot finish without it. */
	required: boolean;
	/** What the producer uses when neither its variable nor `config.toml` sets it. */
	defaultValue: unknown;
	/** What setup writes for a missing required setting when given nothing, and offers when asking. */
	suggestion: string | undefined;
};

/** The hosted ingest server, which each platform reaches at `<base>/<platform>/v1`. */
const HOSTED_INGEST_BASE = 'wss://ingest.telecord.app';

/**
 * The value setup suggests for a setting of a new install. Only the ingest
 * URL has one: the hosted server, which the producer schemas leave out since
 * the producers can run against any deployment.
 */
function suggestionFor(platform: PlatformName, path: readonly string[]): string | undefined {
	return path.join('.') === 'ingest.url' ? `${HOSTED_INGEST_BASE}/${platform}/v1` : undefined;
}

/**
 * The flag of a setting: its TOML path in kebab case.
 *
 * @example
 * settingFlag(['telegram', 'ingest', 'api_key']); // '--telegram-ingest-api-key'
 */
export function settingFlag(tomlPath: readonly string[]): string {
	return `--${tomlPath.join('-').replaceAll('_', '-')}`;
}

/**
 * The CLI's environment variable for a setting: its TOML path, upper-cased,
 * behind `TELECORD_`. Distinct from the producer's own variable in the
 * setting's metadata, which only the container reads.
 *
 * @example
 * settingEnv(['telegram', 'ingest', 'api_key']); // 'TELECORD_TELEGRAM_INGEST_API_KEY'
 */
export function settingEnv(tomlPath: readonly string[]): string {
	return `TELECORD_${tomlPath.join('_').toUpperCase()}`;
}

/**
 * Every setting of a platform, derived from its config schema.
 *
 * @param platform - The platform.
 * @returns Its settings, depth first.
 */
export function platformSettings(platform: Platform): Setting[] {
	return configFields(platform.schema).map((field) => {
		const tomlPath = [platform.name, ...field.path];
		const secret = field.meta.secret === true;
		const unset = z.safeParse(field.schema, undefined);

		return {
			...field,
			platform: platform.name,
			tomlPath,
			key: tomlPath.join('.'),
			flag: secret ? undefined : settingFlag(tomlPath),
			env: settingEnv(tomlPath),
			secret,
			required: !unset.success,
			defaultValue: unset.data,
			suggestion: suggestionFor(platform.name, field.path),
		};
	});
}

/** Every setting of every platform. */
export function allSettings(): Setting[] {
	return PLATFORMS.flatMap(platformSettings);
}

/**
 * Converts text from a flag, variable, prompt or env file into the value
 * written to `config.toml`. Text that is JSON the setting accepts is written
 * as that value, so `500` becomes a number and a rule list an array of
 * tables; anything else is written as the string.
 *
 * @param setting - The setting.
 * @param raw - The text.
 * @returns The value.
 * @throws When the setting rejects the text, naming the setting.
 */
export function toTomlValue(setting: Setting, raw: string): unknown {
	let json: unknown;

	try {
		json = JSON.parse(raw);
	} catch {
		json = undefined;
	}

	if (
		json !== undefined &&
		typeof json !== 'string' &&
		z.safeParse(setting.schema, json).success
	) {
		return json;
	}

	const parsed = z.safeParse(setting.schema, raw);

	if (!parsed.success) {
		throw new Error(
			`Invalid ${setting.key}: ${parsed.error.issues.map((issue) => issue.message).join('; ')}`,
		);
	}

	return raw;
}
