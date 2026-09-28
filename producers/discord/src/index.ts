import { Client } from 'discord.js-selfbot-v13';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';

import { OUTBOX_FILE, Outbox, createTaggedLogger, parseEnv } from '@telecord/producer-core';

import { createDiscordProducer } from './producer';
import { DiscordEnvSchema } from './env';
import { loadSession } from './session';

const env = parseEnv(DiscordEnvSchema);
const logger = createTaggedLogger('Discord Producer');

mkdirSync(env.DATA_DIR, { recursive: true });

const outbox = new Outbox(join(env.DATA_DIR, OUTBOX_FILE));
const client = new Client({ session: loadSession(outbox) });

const producer = createDiscordProducer({
	client,
	filter: { rules: env.FILTER_RULES, fallback: env.FILTER_DEFAULT },
	url: env.INGEST_URL,
	apiKey: env.INGEST_API_KEY,
	outbox,
	window: env.INGEST_WINDOW,
	onFatal: (reason) => {
		logger.error(`The ingest server refused this producer (${reason}), shutting down`);
		shutdown(1);
	},
});

function shutdown(code = 0): void {
	producer.connection.stop();
	client.destroy({ resumable: true });
	outbox.close();
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

process.once('SIGINT', () => shutdown());
process.once('SIGTERM', () => shutdown());

await client.login(env.DISCORD_TOKEN);
