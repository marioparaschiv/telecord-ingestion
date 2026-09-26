import { Client } from 'discord.js-selfbot-v13';

import { createTaggedLogger, parseEnv } from '@telecord/producer-core';

import { createDiscordProducer } from './producer';
import { DiscordEnvSchema } from './env';

const env = parseEnv(DiscordEnvSchema);
const logger = createTaggedLogger('Discord Producer');
const client = new Client();

const { connection, dispatches } = createDiscordProducer({
	client,
	filter: { rules: env.FILTER_RULES, fallback: env.FILTER_DEFAULT },
	url: env.INGEST_URL,
	apiKey: env.INGEST_API_KEY,
	onFatal: (reason) => {
		logger.error(`The ingest server refused this producer (${reason}), shutting down`);
		shutdown(1);
	},
});

function shutdown(code = 0): void {
	connection.stop();
	client.destroy();
	process.exit(code);
}

client.on('raw', (packet) => dispatches.onPacket(packet));
client.on('error', (error) => logger.error(`Discord client error: ${error.message}`));

// The first snapshot is answered from the cache, so the connection waits until the cache is filled.
client.once('ready', (ready) => {
	logger.info(`Logged in to Discord as ${ready.user.tag} (${ready.user.id})`);
	connection.start();
});

process.once('SIGINT', () => shutdown());
process.once('SIGTERM', () => shutdown());

await client.login(env.DISCORD_TOKEN);
