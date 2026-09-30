import { z } from 'zod';

import {
	IngestConfigSchema,
	createFilterConfigSchema,
	createForwardConfigSchema,
} from '@telecord/producer-core/config';

import { DISCORD_FILTER_FIELDS, DISCORD_FORWARD } from './filter';

export { DISCORD_FORWARD, type DiscordForwardEntry } from './filter';

/** The producer's table in `config.toml`. */
export const DISCORD_CONFIG_SECTION = 'discord';

/** The `[discord.forward]` table: the servers and channels the picker shares and hides. */
export const DiscordForwardSchema = createForwardConfigSchema(DISCORD_FORWARD);

/** The `[discord]` table of `config.toml`. */
export const DiscordConfigSchema = z.object({
	token: z.string().min(1).meta({
		env: 'DISCORD_TOKEN',
		secret: true,
		description: 'The token of the Discord account.',
	}),
	data_dir: z.string().min(1).default('/data').meta({
		env: 'DATA_DIR',
		description: 'Holds the outbox.',
	}),
	ingest: IngestConfigSchema,
	filter: createFilterConfigSchema(DISCORD_FILTER_FIELDS),
	forward: DiscordForwardSchema,
});

export type DiscordConfig = z.output<typeof DiscordConfigSchema>;

/** The table as `list-chats` reads it: it never connects to the ingest server. */
export const DiscordSessionConfigSchema = DiscordConfigSchema.extend({
	ingest: IngestConfigSchema.partial(),
});
