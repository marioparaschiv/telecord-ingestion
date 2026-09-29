import { z } from 'zod';

import { parseEnv } from '@telecord/producer-core';

/**
 * Parses the comma-separated `key=value` encoding OTel specifies for `OTEL_HEADERS`
 * and `OTEL_RESOURCE_ATTRIBUTES`.
 */
function parseKeyValueList(raw: string): Record<string, string> {
	const entries: Record<string, string> = {};

	for (const pair of decodeURIComponent(raw).split(',')) {
		// Values may contain `=` themselves (base64 tokens), so only the first splits.
		const separator = pair.indexOf('=');

		if (separator <= 0) {
			continue;
		}

		const key = pair.slice(0, separator).trim();
		const value = pair.slice(separator + 1).trim();

		if (key && value) {
			entries[key] = value;
		}
	}

	return entries;
}

// A blank value is indistinguishable from an unset one, so it yields no entries
// rather than an error. Non-blank input parsing to nothing is a misconfiguration.
const KeyValueListSchema = z
	.string()
	.transform((raw) => (raw.trim() === '' ? undefined : raw))
	.pipe(
		z
			.string()
			.transform(parseKeyValueList)
			.refine((entries) => Object.keys(entries).length > 0, {
				message: 'Expected comma-separated key=value pairs',
			})
			.optional(),
	);

const OtelEnvSchema = z.object({
	OTEL_ENDPOINT: z
		.string()
		.min(1)
		.refine((value) => URL.canParse(value), { message: 'Invalid URL' })
		.transform((value) => value.replace(/\/+$/, '')),
	OTEL_SERVICE_NAME: z.string().min(1),
	OTEL_HEADERS: KeyValueListSchema.optional(),
	OTEL_RESOURCE_ATTRIBUTES: KeyValueListSchema.optional(),
});

export type OtelEnv = {
	endpoint: string;
	serviceName: string;
	headers: Record<string, string>;
	resourceAttributes: Record<string, string>;
};

/**
 * Reads and validates the telemetry environment.
 *
 * @param source - The variables to read.
 * @returns The telemetry config, or `null` when `OTEL_ENABLED`, the single gate, is
 * unset or falsy.
 * @throws When telemetry is enabled but the environment is missing or invalid, so a
 * misconfigured producer fails at startup instead of silently dropping telemetry.
 */
function parseOtelEnv(source: NodeJS.ProcessEnv = process.env): OtelEnv | null {
	const enabled = source.OTEL_ENABLED === 'true' || source.OTEL_ENABLED === '1';

	if (!enabled) {
		return null;
	}

	const parsed = parseEnv(OtelEnvSchema, source);

	return {
		endpoint: parsed.OTEL_ENDPOINT,
		serviceName: parsed.OTEL_SERVICE_NAME,
		headers: parsed.OTEL_HEADERS ?? {},
		resourceAttributes: parsed.OTEL_RESOURCE_ATTRIBUTES ?? {},
	};
}

export default parseOtelEnv;
