import '@telecord/producer-otel/register';
import './logging';

import { shutdown as shutdownTelemetry } from '@telecord/producer-otel';
import { asError, createTaggedLogger } from '@telecord/producer-core';
import { loadConfig } from '@telecord/producer-core/config';

import {
	TELEGRAM_CONFIG_SECTION,
	TelegramConfigSchema,
	TelegramSessionConfigSchema,
} from './config';
import listTelegramChats from './list-chats';
import createTelegramClient from './client';
import produce from './produce';
import logIn from './login';

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
	const client = createTelegramClient({
		apiId: config.api_id,
		apiHash: config.api_hash,
		dataDir: config.data_dir,
	});

	try {
		const output =
			mode === 'login'
				? await logIn(client, (prompt) => client.input(prompt))
				: JSON.stringify(await listTelegramChats(client));

		process.stdout.write(`${output}\n`);

		return 0;
	} catch (error) {
		const { message } = asError(error);

		// A failed login already names the step it failed at.
		logger.error(mode === 'login' ? message : `Failed to list the Telegram chats: ${message}`);

		return 1;
	} finally {
		await client.destroy();
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
