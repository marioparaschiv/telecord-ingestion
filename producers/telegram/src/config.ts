import { z } from 'zod';

import {
	IngestConfigSchema,
	createFilterConfigSchema,
	createForwardConfigSchema,
} from '@telecord/producer-core/config';

import { TELEGRAM_FILTER_FIELDS, TELEGRAM_FORWARD } from './filter';

export { TELEGRAM_FORWARD, type TelegramForwardEntry } from './filter';

/** The producer's table in `config.toml`. */
export const TELEGRAM_CONFIG_SECTION = 'telegram';

/** The `[telegram.forward]` table: the chats the picker shares and hides. */
export const TelegramForwardSchema = createForwardConfigSchema(TELEGRAM_FORWARD);

/** The `[telegram]` table of `config.toml`. */
export const TelegramConfigSchema = z.object({
	api_id: z.coerce.number().int().positive().meta({
		env: 'TELEGRAM_API_ID',
		description: 'The API id of your app at https://my.telegram.org.',
	}),
	api_hash: z.string().min(1).meta({
		env: 'TELEGRAM_API_HASH',
		secret: true,
		description: 'The API hash of your app at https://my.telegram.org.',
	}),
	data_dir: z.string().min(1).default('/data').meta({
		env: 'DATA_DIR',
		description:
			'Holds the SQLite session (auth keys, the peer cache and the update state) and the outbox.',
	}),
	ingest: IngestConfigSchema,
	filter: createFilterConfigSchema(TELEGRAM_FILTER_FIELDS),
	forward: TelegramForwardSchema,
});

export type TelegramConfig = z.output<typeof TelegramConfigSchema>;

/** The table as `login` and `list-chats` read it: they never connect to the ingest server. */
export const TelegramSessionConfigSchema = TelegramConfigSchema.extend({
	ingest: IngestConfigSchema.partial(),
});
