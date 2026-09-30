import { toTomlValue, type Setting } from './settings';
import { valueAt } from './config-file';

/** A value to write to `config.toml`. */
export type SettingValue = { setting: Setting; value: unknown };

type ResolveOptions = {
	/** The values of the settings' flags, by setting key. */
	flags: Readonly<Partial<Record<string, string>>>;
	env: NodeJS.ProcessEnv;
	/** The parsed `config.toml`. */
	current: Readonly<Record<string, unknown>>;
	/** Asks for a required setting; undefined when nothing may be asked. */
	prompt: ((setting: Setting) => Promise<unknown>) | undefined;
};

/** How a setting can be given without a prompt. */
export function describeInput(setting: Setting): string {
	return setting.flag === undefined
		? `set ${setting.env}`
		: `pass ${setting.flag} or set ${setting.env}`;
}

/**
 * Works out what to write for each setting: its flag, else its `TELECORD_`
 * variable, else nothing when `config.toml` already has it or it is
 * optional, else what the prompt answers, or its suggestion when nothing may
 * be asked.
 *
 * @param settings - The settings of the platforms being set up.
 * @param options - The flags, environment, current file and prompt.
 * @returns The values to write.
 * @throws When a value is invalid, or required values are missing and there is no prompt,
 * naming each one's flag or variable.
 */
export async function resolveSettings(
	settings: readonly Setting[],
	{ flags, env, current, prompt }: ResolveOptions,
): Promise<SettingValue[]> {
	const values: SettingValue[] = [];
	const missing: Setting[] = [];

	for (const setting of settings) {
		const raw =
			(setting.flag === undefined ? undefined : flags[setting.key]) ?? env[setting.env];

		if (raw !== undefined) {
			values.push({ setting, value: toTomlValue(setting, raw) });
		} else if (setting.required && valueAt(current, setting.tomlPath) === undefined) {
			missing.push(setting);
		}
	}

	if (missing.length === 0) {
		return values;
	}

	if (prompt !== undefined) {
		for (const setting of missing) {
			values.push({ setting, value: await prompt(setting) });
		}

		return values;
	}

	const unanswerable = missing.filter(({ suggestion }) => suggestion === undefined);

	if (unanswerable.length > 0) {
		const lines = unanswerable.map((setting) => `  ${setting.key}: ${describeInput(setting)}`);

		throw new Error(`Missing required settings:\n${lines.join('\n')}`);
	}

	return [
		...values,
		...missing.flatMap((setting) =>
			setting.suggestion === undefined
				? []
				: [{ setting, value: toTomlValue(setting, setting.suggestion) }],
		),
	];
}
