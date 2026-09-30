import { Command } from 'commander';

import { formatSettingSource, formatSettingValue, settingSource } from '../setting-source';
import { parseConfigFile, readConfigFile, writeConfigFile } from '../config-file';
import { installDirOption, installedPlatforms, openInstall } from '../install';
import { allSettings, platformSettings, toTomlValue } from '../settings';
import { configProblem, serviceEnvironment } from '../config-check';
import { canPrompt, promptSetting, readStdin } from '../prompt';
import { composeModel } from '../docker';
import setTomlValue from '../toml-edit';
import PLATFORMS from '../platforms';

const show = new Command('show')
	.description('Show the settings each producer runs with and where each one comes from')
	.addOption(installDirOption())
	.action(async (options: { dir?: string }) => {
		const install = await openInstall(options.dir);
		const table = parseConfigFile(install.config, await readConfigFile(install.config));
		const enabled = await installedPlatforms(install);
		const platforms = PLATFORMS.filter((platform) =>
			enabled.length > 0 ? enabled.includes(platform.name) : platform.name in table,
		);
		const model = await composeModel(install.dir);

		for (const platform of platforms) {
			const env = serviceEnvironment(model, platform);
			const problem = configProblem(install.config, platform, env);
			const rows = platformSettings(platform).map((setting) => {
				const found = settingSource(setting, table, env);

				return {
					key: setting.key,
					value: formatSettingValue(setting, found),
					source: formatSettingSource(found),
				};
			});
			const keyWidth = Math.max(...rows.map((row) => row.key.length));
			const valueWidth = Math.max(...rows.map((row) => row.value.length));

			console.log(`${platform.label}: ${problem === undefined ? 'valid' : 'invalid'}`);

			for (const { key, value, source } of rows) {
				console.log(`  ${key.padEnd(keyWidth)}  ${value.padEnd(valueWidth)}  ${source}`);
			}

			if (problem !== undefined) {
				console.log(problem.replaceAll(/^/gm, '  '));
			}

			console.log('');
		}
	});

const set = new Command('set')
	.description(
		'Set one setting in config.toml, leaving the rest of the file as it is. Without a value, it is read from stdin or asked for; secrets are only taken that way.',
	)
	.argument('<key>', 'The setting, e.g. telegram.ingest.url')
	.argument('[value]', 'Its value; JSON for a list')
	.addOption(installDirOption())
	.action(async (key: string, value: string | undefined, options: { dir?: string }) => {
		const settings = allSettings();
		const setting = settings.find((candidate) => candidate.key === key);

		if (setting === undefined) {
			throw new Error(
				`Failed to set ${key}: no such setting. The settings are:\n${settings.map((candidate) => `  ${candidate.key}`).join('\n')}`,
			);
		}

		if (setting.secret && value !== undefined) {
			throw new Error(
				`Failed to set ${key}: a secret given as an argument stays in the shell history. Pipe it through stdin or answer the prompt.`,
			);
		}

		const install = await openInstall(options.dir);
		const parsed =
			value !== undefined
				? toTomlValue(setting, value)
				: canPrompt()
					? await promptSetting(setting)
					: toTomlValue(setting, await readStdin());
		const source = await readConfigFile(install.config);

		await writeConfigFile(install.config, setTomlValue(source, setting.tomlPath, parsed));
		console.log(`Set ${key}. Run telecord-ingestion restart to apply it.`);
	});

const config = new Command('config')
	.description('Show or change config.toml')
	.addCommand(show)
	.addCommand(set);

export default config;
