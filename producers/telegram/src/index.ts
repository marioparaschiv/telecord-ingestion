import '@telecord/producer-otel/register';
import './logging';

import { join } from 'node:path';

import { loadConfig, type ChatList } from '@telecord/producer-core/config';
import { shutdown as shutdownTelemetry } from '@telecord/producer-otel';
import { asError, createTaggedLogger } from '@telecord/producer-core';

import {
	TELEGRAM_CONFIG_SECTION,
	TelegramConfigSchema,
	TelegramSessionConfigSchema,
	type TelegramAccountConfig,
} from './config';
import { logInAccount, resolveAccountDir } from './account';
import ChatStore, { CHATS_FILE } from './chats';
import listTelegramChats from './list-chats';
import createTelegramClient from './client';
import produce from './produce';

const logger = createTaggedLogger('Telegram Producer');

/**
 * Runs `login` or `list-chats` on the saved session, printing its result to stdout.
 *
 * @returns The exit code.
 */
async function runMode(args: readonly string[]): Promise<number> {
	const [mode] = args;

	if (args.length !== 1 || (mode !== 'login' && mode !== 'list-chats')) {
		logger.error(`Unknown arguments "${args.join(' ')}": expected login or list-chats`);

		return 2;
	}

	const config = loadConfig(TelegramSessionConfigSchema, { section: TELEGRAM_CONFIG_SECTION });

	try {
		const output =
			mode === 'login'
				? (await logInAccount(config)).line
				: JSON.stringify(await listAccountChats(config));

		process.stdout.write(`${output}\n`);

		return 0;
	} catch (error) {
		const { message } = asError(error);

		// A failed login already names the step it failed at.
		logger.error(mode === 'login' ? message : `Failed to list the Telegram chats: ${message}`);

		return 1;
	}
}

/** Lists the chats of the account's saved session, which for a bot are the ones it learned. */
async function listAccountChats(config: TelegramAccountConfig): Promise<ChatList> {
	const dir = await resolveAccountDir(config);
	const client = createTelegramClient({
		apiId: config.api_id,
		apiHash: config.api_hash,
		dataDir: dir,
	});
	const chats = config.bot_token === undefined ? undefined : new ChatStore(join(dir, CHATS_FILE));

	try {
		return await listTelegramChats(client, chats);
	} finally {
		await client.destroy();
		chats?.close();
	}
}

const args = process.argv.slice(2);

if (args.length === 0) {
	await produce(loadConfig(TelegramConfigSchema, { section: TELEGRAM_CONFIG_SECTION }));
} else {
	const code = await runMode(args);

	await shutdownTelemetry();
	process.exit(code);
}
