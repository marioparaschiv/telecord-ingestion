import { join, resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { Option } from 'commander';
import { homedir } from 'node:os';

import PLATFORMS, { type PlatformName } from './platforms';
import { writeComposeFile } from './compose-file';
import { readEnvFile } from './env-file';

/** The files of an install directory. */
export type Install = {
	dir: string;
	config: string;
	env: string;
};

/** The `--dir` option every command that works on an install takes. */
export function installDirOption(): Option {
	return new Option('--dir <path>', 'The install directory').env('TELECORD_INGESTION_DIR');
}

/**
 * Finds the install directory: the one given, else the current directory
 * when it holds an install, else `~/telecord-ingestion`.
 *
 * @param dir - The directory from `--dir` or `TELECORD_INGESTION_DIR`, a leading `~` meaning the home directory.
 * @param cwd - The current directory.
 * @param home - The home directory.
 * @returns The absolute path.
 */
export function resolveInstallDir(
	dir: string | undefined,
	cwd = process.cwd(),
	home = homedir(),
): string {
	if (dir !== undefined) {
		return resolve(cwd, dir.replace(/^~(?=$|[/\\])/, home));
	}

	if (existsSync(join(cwd, 'config.toml')) || existsSync(join(cwd, 'compose.yml'))) {
		return cwd;
	}

	return join(home, 'telecord-ingestion');
}

/**
 * Opens an install and regenerates its `compose.yml`, so every command runs
 * against the compose file this CLI version ships.
 *
 * @param dir - The directory from `--dir` or `TELECORD_INGESTION_DIR`.
 * @param create - Whether a missing install is created, as setup does.
 * @returns The install's files.
 * @throws When the install does not exist and is not created.
 */
export async function openInstall(dir: string | undefined, create = false): Promise<Install> {
	const root = resolveInstallDir(dir);
	const install = { dir: root, config: join(root, 'config.toml'), env: join(root, '.env') };

	if (create) {
		await mkdir(root, { recursive: true });
	} else if (!existsSync(install.config)) {
		throw new Error(
			`Failed to find an install in ${root}: it has no config.toml. Run telecord-ingestion setup, or pass --dir.`,
		);
	}

	await writeComposeFile(root);

	return install;
}

/**
 * The compose profiles an install's `.env` enables: its producers and the updater.
 *
 * @param env - The install's `.env`.
 * @returns The profiles, in the order `.env` lists them.
 */
export function composeProfiles(env: NodeJS.Dict<string>): string[] {
	return (env.COMPOSE_PROFILES ?? '')
		.split(',')
		.map((profile) => profile.trim())
		.filter((profile) => profile !== '');
}

/**
 * The platforms an install runs: the producer profiles its `.env` enables.
 *
 * @param env - The install's `.env`.
 * @returns The platforms, in the order the CLI lists them.
 */
export function enabledPlatforms(env: NodeJS.Dict<string>): PlatformName[] {
	const profiles = new Set(composeProfiles(env));

	return PLATFORMS.filter((platform) => profiles.has(platform.name)).map(({ name }) => name);
}

/**
 * Reads the platforms an install runs from its `.env`.
 *
 * @param install - The install.
 * @returns The platforms, none when it has no `.env`.
 */
export async function installedPlatforms(install: Install): Promise<PlatformName[]> {
	return enabledPlatforms((await readEnvFile(install.env)) ?? {});
}
