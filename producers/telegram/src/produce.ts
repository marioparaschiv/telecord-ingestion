import { join } from 'node:path';

import { OUTBOX_FILE, Outbox, createTaggedLogger, resolveFilter } from '@telecord/producer-core';
import { shutdown as shutdownTelemetry } from '@telecord/producer-otel';

import type { TelegramConfig } from './config';

import { createTelegramProducer } from './producer';
import createTelegramClient from './client';
import { TELEGRAM_FORWARD } from './filter';
import logIn from './login';

const logger = createTaggedLogger('Telegram Producer');

/**
 * Runs the producer until a signal or a fatal refusal ends the process: logs
 * in, catches up on missed updates and forwards the account to the ingest server.
 *
 * @param config - The producer's settings.
 */
async function produce(config: TelegramConfig): Promise<void> {
	const client = createTelegramClient({
		apiId: config.api_id,
		apiHash: config.api_hash,
		dataDir: config.data_dir,
		producer: {
			onChannelTooLong: (_channelId, difference) => updates.onChannelTooLong(difference),
			onUnauthorized: (reason) => session.onUnauthorized(reason),
			onUpdatesSkipped: (reason) => session.onUpdatesSkipped(reason),
		},
	});

	const outbox = new Outbox(join(config.data_dir, OUTBOX_FILE));

	const { connection, updates, session } = createTelegramProducer({
		client,
		filter: resolveFilter(config, TELEGRAM_FORWARD),
		url: config.ingest.url,
		apiKey: config.ingest.api_key,
		outbox,
		window: config.ingest.window,
		onFatal: (reason) => {
			logger.error(`The ingest server refused this producer (${reason}), shutting down`);
			void shutdown(1);
		},
	});

	async function shutdown(code = 0): Promise<void> {
		connection.stop();
		await client.destroy();
		outbox.close();
		await shutdownTelemetry();
		process.exit(code);
	}

	client.onError.add((error) => logger.error(`Telegram client error: ${error.message}`));
	client.onRawUpdate.add((info) => updates.onRawUpdate(info));

	// Prompts on the terminal only when the session in DATA_DIR holds no authorization yet.
	logger.info(await logIn(client, (prompt) => client.input(prompt)));

	process.once('SIGINT', () => void shutdown());
	process.once('SIGTERM', () => void shutdown());

	updates.start();

	// IDENTIFY reports whether the catch-up that logging in starts recovered every update.
	await session.caughtUp();
	connection.start();
}

export default produce;
