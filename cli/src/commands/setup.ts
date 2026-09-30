import { checkbox, confirm } from '@inquirer/prompts';
import { Command, Option } from 'commander';

import { composeProfiles, enabledPlatforms, installDirOption, openInstall } from '../install';
import { parseConfigFile, readConfigFile, writeConfigFile } from '../config-file';
import { configProblem, serviceEnvironment } from '../config-check';
import PLATFORMS, { type PlatformName } from '../platforms';
import { compose, composeModel, docker } from '../docker';
import { readEnvFile, writeEnvFile } from '../env-file';
import { resolveSettings } from '../resolve-settings';
import { canPrompt, promptSetting } from '../prompt';
import errorMessage from '../error-message';
import { allSettings } from '../settings';
import setTomlValue from '../toml-edit';
import logInToTelegram from '../login';
import pickChats from '../pick-chats';
import hostUser from '../host-user';

const UPDATER = 'updater';

const settings = allSettings();
const settingOptions = settings.flatMap((setting) =>
	setting.flag === undefined
		? []
		: [
				{
					setting,
					option: new Option(
						`${setting.flag} <value>`,
						[
							setting.meta.description ?? setting.key,
							setting.suggestion === undefined
								? ''
								: ` A new install defaults to ${setting.suggestion}.`,
						].join(''),
					).env(setting.env),
				},
			],
);
const secrets = settings.filter((setting) => setting.secret);

type SetupOptions = {
	dir?: string;
	platforms?: string;
	updater?: 'on' | 'off';
	checkInterval?: string;
	updateDelay?: string;
	yes?: boolean;
	simple?: boolean;
	[flag: string]: unknown;
};

function parsePlatforms(list: string): PlatformName[] {
	const names = list
		.split(',')
		.map((name) => name.trim())
		.filter((name) => name !== '');
	const unknown = names.filter((name) => !PLATFORMS.some((platform) => platform.name === name));

	if (unknown.length > 0 || names.length === 0) {
		throw new Error(
			`Invalid --platforms ${list}: choose from ${PLATFORMS.map(({ name }) => name).join(', ')}`,
		);
	}

	return PLATFORMS.filter((platform) => names.includes(platform.name)).map(({ name }) => name);
}

async function choosePlatforms(
	list: string | undefined,
	current: readonly PlatformName[],
	interactive: boolean,
): Promise<PlatformName[]> {
	if (list !== undefined) {
		return parsePlatforms(list);
	}

	if (current.length > 0) {
		return [...current];
	}

	if (!interactive) {
		throw new Error('Missing platforms: pass --platforms or set TELECORD_PLATFORMS');
	}

	return checkbox({
		message: 'Platforms to connect',
		choices: PLATFORMS.map((platform) => ({ name: platform.label, value: platform.name })),
		required: true,
	});
}

async function chooseUpdater(
	mode: 'on' | 'off' | undefined,
	current: boolean | undefined,
	interactive: boolean,
): Promise<boolean> {
	if (mode !== undefined) {
		return mode === 'on';
	}

	if (current !== undefined) {
		return current;
	}

	if (!interactive) {
		return true;
	}

	return confirm({
		message:
			'Install updates automatically? The updater verifies each release and needs access to the Docker socket.',
		default: true,
	});
}

const setup = new Command('setup')
	.description(
		'Set up the producers, or change an install. Asks only for required settings that are missing.',
	)
	.addOption(installDirOption())
	.addOption(
		new Option(
			'--platforms <names>',
			`The platforms to run, comma-separated: ${PLATFORMS.map(({ name }) => name).join(', ')}`,
		).env('TELECORD_PLATFORMS'),
	)
	.addOption(
		new Option('--updater <mode>', 'Install new releases automatically')
			.choices(['on', 'off'])
			.env('TELECORD_UPDATER'),
	)
	.addOption(
		new Option('--check-interval <duration>', 'How often the updater checks, e.g. 24h').env(
			'TELECORD_CHECK_INTERVAL',
		),
	)
	.addOption(
		new Option(
			'--update-delay <duration>',
			'How long a release waits before it is installed',
		).env('TELECORD_UPDATE_DELAY'),
	)
	.option('-y, --yes', 'Never prompt: fail when a required setting is missing')
	.option('--simple', 'Skip the chat picker and forward what config.toml allows');

for (const { option } of settingOptions) {
	setup.addOption(option);
}

setup.addHelpText(
	'after',
	[
		'',
		'Secrets are never taken as flags. Set them in the environment, or answer the hidden prompt:',
		...secrets.map(
			(setting) => `  ${setting.env.padEnd(40)} ${setting.meta.description ?? ''}`,
		),
	].join('\n'),
);

setup.action(async (options: SetupOptions) => {
	const interactive = canPrompt(options.yes);

	await docker(['compose', 'version'], { capture: true });

	const install = await openInstall(options.dir, true);
	const env = await readEnvFile(install.env);
	const previous = enabledPlatforms(env ?? {});
	const platforms = await choosePlatforms(options.platforms, previous, interactive);
	const hadUpdater = env === undefined ? undefined : composeProfiles(env).includes(UPDATER);
	const updater = await chooseUpdater(options.updater, hadUpdater, interactive);
	const flags = Object.fromEntries(
		settingOptions.map(({ setting, option }) => {
			const value: unknown = options[option.attributeName()];

			return [setting.key, typeof value === 'string' ? value : undefined];
		}),
	);
	const stray = settingOptions.filter(
		({ setting, option }) =>
			!platforms.includes(setting.platform) &&
			setup.getOptionValueSource(option.attributeName()) === 'cli',
	);

	if (stray.length > 0) {
		throw new Error(
			`${stray.map(({ setting }) => setting.flag).join(', ')} set a platform that is not being set up; add it to --platforms`,
		);
	}

	const current = await readConfigFile(install.config);
	const values = await resolveSettings(
		settings.filter((setting) => platforms.includes(setting.platform)),
		{
			flags,
			env: process.env,
			current: parseConfigFile(install.config, current),
			prompt: interactive ? promptSetting : undefined,
		},
	);
	const source = values.reduce(
		(text, { setting, value }) => setTomlValue(text, setting.tomlPath, value),
		current,
	);
	const user = hostUser();

	await writeConfigFile(install.config, source);
	await writeEnvFile(install.env, {
		...env,
		COMPOSE_PROFILES: [...platforms, ...(updater ? [UPDATER] : [])].join(','),
		HOST_UID: user === undefined ? undefined : String(user.uid),
		HOST_GID: user === undefined ? undefined : String(user.gid),
		CHECK_INTERVAL: options.checkInterval ?? env?.CHECK_INTERVAL,
		UPDATE_DELAY: options.updateDelay ?? env?.UPDATE_DELAY,
	});

	const model = await composeModel(install.dir);
	const problems = PLATFORMS.filter((platform) => platforms.includes(platform.name)).flatMap(
		(platform) => {
			const problem = configProblem(
				install.config,
				platform,
				serviceEnvironment(model, platform),
			);

			return problem === undefined ? [] : [`${platform.label}: ${problem}`];
		},
	);

	if (problems.length > 0) {
		throw new Error(`Failed to set up ${install.dir}:\n${problems.join('\n')}`);
	}

	console.log(`Wrote ${install.config} and ${install.env}`);

	const dropped = [
		...previous.filter((platform) => !platforms.includes(platform)),
		...(hadUpdater === true && !updater ? [UPDATER] : []),
	];

	if (dropped.length > 0) {
		await compose(install.dir, ['--profile', '*', 'rm', '--stop', '--force', ...dropped]);
	}

	const pendingLogin = platforms.includes('telegram') && !previous.includes('telegram');

	if (pendingLogin && interactive) {
		console.log('Log in to Telegram: answer the phone, code and 2FA prompts.');
		await logInToTelegram(install.dir);
	}

	const services = [...platforms, ...(updater ? [UPDATER] : [])].filter(
		(service) => service !== 'telegram' || !pendingLogin || interactive,
	);

	if (services.length > 0) {
		await compose(install.dir, ['up', '--detach', '--remove-orphans', ...services]);
	}

	if (pendingLogin && !interactive) {
		console.log('Telegram starts once logged in: run telecord-ingestion login telegram');
	}

	console.log(`Telecord ingestion is running in ${install.dir}`);

	if (!interactive || options.simple) {
		return;
	}

	try {
		for (const platform of platforms) {
			await pickChats(install, platform);
		}
	} catch (error) {
		throw new Error(
			`Failed to pick the chats to forward: ${errorMessage(error)}. Run telecord-ingestion filters to retry.`,
			{ cause: error },
		);
	}
});

export default setup;
