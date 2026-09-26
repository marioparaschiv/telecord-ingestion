import { createTaggedLogger, parseEnv } from '@telecord/producer-core';

import { createTelegramProducer } from './producer';
import createTelegramClient from './client';
import { TelegramEnvSchema } from './env';

const env = parseEnv(TelegramEnvSchema);
const logger = createTaggedLogger('Telegram Producer');

const client = createTelegramClient({
	apiId: env.TELEGRAM_API_ID,
	apiHash: env.TELEGRAM_API_HASH,
	dataDir: env.DATA_DIR,
	onChannelTooLong: (channelId, difference) => updates.onChannelTooLong(channelId, difference),
});

const { connection, updates } = createTelegramProducer({
	client,
	filter: { rules: env.FILTER_RULES, fallback: env.FILTER_DEFAULT },
	url: env.INGEST_URL,
	apiKey: env.INGEST_API_KEY,
	onFatal: (reason) => {
		logger.error(`The ingest server refused this producer (${reason}), shutting down`);
		void shutdown(1);
	},
});

async function shutdown(code = 0): Promise<void> {
	connection.stop();
	await client.destroy();
	process.exit(code);
}

client.onError.add((error) => logger.error(`Telegram client error: ${error.message}`));
client.onRawUpdate.add((info) => updates.onRawUpdate(info));

// Prompts on the terminal only when the session in DATA_DIR holds no authorization yet.
const me = await client.start({
	phone: () => client.input('Phone number (international format): '),
	code: () => client.input('Login code: '),
	password: () => client.input('2FA password: '),
});

logger.info(`Logged in to Telegram as ${me.displayName} (${me.id})`);

process.once('SIGINT', () => void shutdown());
process.once('SIGTERM', () => void shutdown());

connection.start();
