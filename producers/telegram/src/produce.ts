import { mkdirSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

import { OUTBOX_FILE, Outbox, createTaggedLogger, resolveFilter } from '@telecord/producer-core';
import { shutdown as shutdownTelemetry } from '@telecord/producer-otel';

import type { TelegramConfig } from './config';

import { createTelegramProducer } from './producer';
import ChatStore, { CHATS_FILE } from './chats';
import createTelegramClient from './client';
import { TELEGRAM_FORWARD } from './filter';
import { openAccountDir } from './account';
import logIn from './login';

const logger = createTaggedLogger('Telegram Producer');

/**
 * Runs the producer until a signal or a fatal refusal ends the process: logs
 * in, catches up on missed updates and forwards the account to the ingest server.
 *
 * @param config - The producer's settings.
 */
async function produce(config: TelegramConfig): Promise<void> {
	const dir = await openAccountDir(config);
	const client = createTelegramClient({
		apiId: config.api_id,
		apiHash: config.api_hash,
		dataDir: dir,
		producer: {
			onChannelTooLong: (_channelId, difference) => updates.onChannelTooLong(difference),
			onUnauthorized: (reason) => session.onUnauthorized(reason),
			onUpdatesSkipped: (reason) => session.onUpdatesSkipped(reason),
		},
	});

	const outbox = new Outbox(join(dir, OUTBOX_FILE));
	const chats = config.bot_token === undefined ? undefined : new ChatStore(join(dir, CHATS_FILE));
	const downloadDir = join(config.data_dir, 'downloads');

	// A download a previous run was stopped in the middle of is never finished.
	rmSync(downloadDir, { recursive: true, force: true });
	mkdirSync(downloadDir, { recursive: true });

	const { connection, updates, session } = createTelegramProducer({
		client,
		filter: resolveFilter(config, TELEGRAM_FORWARD),
		url: config.ingest.url,
		apiKey: config.ingest.api_key,
		outbox,
		chats,
		window: config.ingest.window,
		downloadDir,
		onFatal: (reason) => {
			logger.error(`The ingest server refused this producer (${reason}), shutting down`);
			void shutdown(1);
		},
	});

	async function shutdown(code = 0): Promise<void> {
		connection.stop();
		await client.destroy();
		outbox.close();
		chats?.close();
		await shutdownTelemetry();
		process.exit(code);
	}

	client.onError.add((error) => logger.error(`Telegram client error: ${error.message}`));
	client.onRawUpdate.add((info) => updates.onRawUpdate(info));

	// Prompts on the terminal only when a user account's session lost its authorization.
	const login = await logIn(client, (prompt) => client.input(prompt), config.bot_token);

	// The outbox is the stream of the account the directory is named after.
	if (String(login.userId) !== basename(dir)) {
		throw new Error(
			`Failed to produce from ${dir}: its session is logged in as ${login.userId}. Run the login mode to move it.`,
		);
	}

	logger.info(login.line);

	process.once('SIGINT', () => void shutdown());
	process.once('SIGTERM', () => void shutdown());

	updates.start();

	// IDENTIFY reports whether the catch-up that logging in starts recovered every update.
	await session.caughtUp();
	connection.start();
}

export default produce;
