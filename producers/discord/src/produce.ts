import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { OUTBOX_FILE, Outbox, createTaggedLogger, resolveFilter } from '@telecord/producer-core';
import { shutdown as shutdownTelemetry } from '@telecord/producer-otel';

import type { DiscordConfig } from './config';

import { createDiscordClient, fetchClientBuild } from './client';
import { createDiscordProducer } from './producer';
import { DISCORD_FORWARD } from './filter';
import { loadSession } from './session';

const logger = createTaggedLogger('Discord Producer');

/**
 * Runs the producer until a signal or a fatal refusal ends the process: logs
 * in to the gateway, resuming the stored session where it can, and forwards
 * the account to the ingest server.
 *
 * @param config - The producer's settings.
 */
async function produce(config: DiscordConfig): Promise<void> {
	mkdirSync(config.data_dir, { recursive: true });

	const outbox = new Outbox(join(config.data_dir, OUTBOX_FILE));
	const client = createDiscordClient(await fetchClientBuild(), loadSession(outbox));

	const producer = createDiscordProducer({
		client,
		filter: resolveFilter(config, DISCORD_FORWARD),
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
		producer.connection.stop();
		client.destroy({ resumable: true });
		outbox.close();
		await shutdownTelemetry();
		process.exit(code);
	}

	client.on('raw', (packet) => producer.onPacket(packet));
	client.on('error', (error) => logger.error(`Discord client error: ${error.message}`));

	// The first snapshot is answered from the cache, and IDENTIFY says whether a stored session resumed:
	// the client knows both once it is ready.
	client.once('ready', (ready) => {
		logger.info(`Logged in to Discord as ${ready.user.tag} (${ready.user.id})`);
		producer.connection.start();
	});

	process.once('SIGINT', () => void shutdown());
	process.once('SIGTERM', () => void shutdown());

	await client.login(config.token);
}

export default produce;
