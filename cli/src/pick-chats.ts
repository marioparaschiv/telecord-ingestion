import { confirm } from '@inquirer/prompts';
import { z } from 'zod';

import type { PlatformName } from './platforms';
import type { Install } from './install';

import { parseConfigFile, readConfigFile, valueAt, writeConfigFile } from './config-file';
import { DISCORD_PICKER, TELEGRAM_PICKER, type PickerPlatform } from './picker/platforms';
import { forwardOf, stateOf } from './picker/model';
import runPicker from './picker/run-picker';
import { restartServices } from './docker';
import setTomlValue from './toml-edit';
import listChats from './list-chats';

function readTable<T>(
	schema: z.ZodType<T>,
	file: string,
	table: Record<string, unknown>,
	path: readonly string[],
): T {
	const parsed = schema.safeParse(valueAt(table, path) ?? {});

	if (!parsed.success) {
		throw new Error(
			`Failed to read ${path.join('.')} in ${file}:\n${z.prettifyError(parsed.error)}`,
		);
	}

	return parsed.data;
}

async function pickPlatformChats<Entry extends object>(
	install: Install,
	platform: PickerPlatform<Entry>,
): Promise<void> {
	const table = parseConfigFile(install.config, await readConfigFile(install.config));
	const forward = readTable(platform.forwardSchema, install.config, table, [
		platform.name,
		'forward',
	]);
	const filter = readTable(platform.filterSchema, install.config, table, [
		platform.name,
		'filter',
	]);

	console.log(`Listing the ${platform.label} chats`);

	const { chats } = await listChats(install.dir, platform.name);
	const saved = await runPicker({
		platform,
		chats,
		initial: stateOf(forward, filter.fallback, platform),
		filter,
	});

	if (saved === undefined) {
		throw new Error(`Cancelled picking the ${platform.label} chats: config.toml is unchanged`);
	}

	const source = await readConfigFile(install.config);

	await writeConfigFile(
		install.config,
		setTomlValue(source, [platform.name, 'forward'], forwardOf(saved)),
	);
	console.log(`Saved the ${platform.label} chats to ${install.config}`);

	if (await confirm({ message: `Restart ${platform.label} to apply them?`, default: true })) {
		await restartServices(install.dir, [platform.name]);
	}
}

/**
 * Opens the chat picker on a producer's account, then saves the selection as
 * its `forward` table and offers to restart it.
 *
 * @param install - The install.
 * @param platform - The producer.
 * @throws When the chats cannot be listed, or the picker is cancelled.
 */
async function pickChats(install: Install, platform: PlatformName): Promise<void> {
	await (platform === 'telegram'
		? pickPlatformChats(install, TELEGRAM_PICKER)
		: pickPlatformChats(install, DISCORD_PICKER));
}

export default pickChats;
