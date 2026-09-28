import { z } from 'zod';

import { IngestEnvShape, createFilterEnvShape } from '@telecord/producer-core';

import { DEFAULT_DISCORD_FILTER_RULES, DISCORD_FILTER_FIELDS } from './filter';

export const DiscordEnvSchema = z.object({
	...IngestEnvShape,
	...createFilterEnvShape(DISCORD_FILTER_FIELDS, DEFAULT_DISCORD_FILTER_RULES),
	/** Holds the outbox. */
	DATA_DIR: z.string().min(1).default('/data'),
	DISCORD_TOKEN: z.string().min(1),
});
