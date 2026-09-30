import { z } from 'zod';

/** The `ingest` table of a producer's config: how it reaches the ingest server. */
const IngestConfigSchema = z.object({
	url: z.url({ protocol: /^wss?$/ }).meta({
		env: 'INGEST_URL',
		description: 'The WebSocket URL of the ingest server, ending in the platform route.',
	}),
	api_key: z.string().min(1).meta({
		env: 'INGEST_API_KEY',
		secret: true,
		description: 'The Telecord API key for this account.',
	}),
	window: z.coerce.number().int().positive().default(500).meta({
		env: 'INGEST_WINDOW',
		description: 'The most events sent and not yet acknowledged.',
	}),
});

export default IngestConfigSchema;
