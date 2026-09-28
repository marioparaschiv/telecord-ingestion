import { z } from 'zod';

import { IngestEnvShape, createFilterEnvShape } from '@telecord/producer-core';

import { DEFAULT_TELEGRAM_FILTER_RULES, TELEGRAM_FILTER_FIELDS } from './filter';

export const TelegramEnvSchema = z.object({
	...IngestEnvShape,
	...createFilterEnvShape(TELEGRAM_FILTER_FIELDS, DEFAULT_TELEGRAM_FILTER_RULES),
	/** Holds the SQLite session (auth keys, the peer cache and the update state) and the outbox. */
	DATA_DIR: z.string().min(1).default('/data'),
	TELEGRAM_API_ID: z.coerce.number().int().positive(),
	TELEGRAM_API_HASH: z.string().min(1),
});
