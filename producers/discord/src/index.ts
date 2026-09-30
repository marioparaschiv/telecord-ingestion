import '@telecord/producer-otel/register';
import './logging';

import { Client } from 'discord.js-selfbot-v13';

import { shutdown as shutdownTelemetry } from '@telecord/producer-otel';
import { asError, createTaggedLogger } from '@telecord/producer-core';
import { loadConfig } from '@telecord/producer-core/config';

import { DISCORD_CONFIG_SECTION, DiscordConfigSchema, DiscordSessionConfigSchema } from './config';
import listDiscordChats from './list-chats';
import produce from './produce';

const logger = createTaggedLogger('Discord Producer');

/**
 * Runs `list-chats` on the account's token, printing its result to stdout.
 *
 * @returns The exit code.
 */
async function runMode(args: readonly string[]): Promise<number> {
	if (args.length !== 1 || args[0] !== 'list-chats') {
		logger.error(`Unknown arguments "${args.join(' ')}": expected list-chats`);

		return 2;
	}

	const config = loadConfig(DiscordSessionConfigSchema, { section: DISCORD_CONFIG_SECTION });
	const client = new Client();

	client.token = config.token;

	try {
		process.stdout.write(`${JSON.stringify(await listDiscordChats(client))}\n`);

		return 0;
	} catch (error) {
		logger.error(`Failed to list the Discord chats: ${asError(error).message}`);

		return 1;
	} finally {
		client.destroy();
	}
}

const args = process.argv.slice(2);

if (args.length === 0) {
	await produce(loadConfig(DiscordConfigSchema, { section: DISCORD_CONFIG_SECTION }));
} else {
	const code = await runMode(args);

	await shutdownTelemetry();
	process.exit(code);
}
