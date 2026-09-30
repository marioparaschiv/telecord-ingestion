import type { Setting } from './settings';

import { valueAt } from './config-file';

/** A setting's effective value and where it comes from, in the producer's order of precedence. */
export type SettingSource =
	| { source: 'env'; variable: string; value: string }
	| { source: 'file' | 'default'; value: unknown }
	| { source: 'unset' };

const MASK = '********';

/**
 * Finds the value a producer runs with: its container's variable, else
 * `config.toml`, else the schema's default.
 *
 * @param setting - The setting.
 * @param table - The parsed `config.toml`.
 * @param env - The producer container's environment.
 * @returns The value and its source.
 */
export function settingSource(
	setting: Setting,
	table: Readonly<Record<string, unknown>>,
	env: Readonly<Record<string, string>>,
): SettingSource {
	const variable = setting.meta.env;

	if (variable !== undefined && env[variable] !== undefined) {
		return { source: 'env', variable, value: env[variable] };
	}

	const value = valueAt(table, setting.tomlPath);

	if (value !== undefined) {
		return { source: 'file', value };
	}

	return setting.defaultValue === undefined
		? { source: 'unset' }
		: { source: 'default', value: setting.defaultValue };
}

/**
 * Renders a setting's value for `config show`, masking a secret.
 *
 * @param setting - The setting.
 * @param found - Its value and source.
 * @returns The text shown.
 */
export function formatSettingValue(setting: Setting, found: SettingSource): string {
	if (found.source === 'unset') {
		return setting.required ? '(missing)' : '(unset)';
	}

	if (setting.secret) {
		return MASK;
	}

	return typeof found.value === 'string' ? found.value : JSON.stringify(found.value);
}

/**
 * Renders where a setting's value comes from for `config show`.
 *
 * @param found - Its value and source.
 * @returns The text shown.
 */
export function formatSettingSource(found: SettingSource): string {
	return found.source === 'env' ? `env ${found.variable}` : found.source;
}
