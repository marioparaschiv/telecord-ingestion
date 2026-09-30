import type { z } from 'zod';

/**
 * Parses the environment against a producer's schema, failing loudly with every
 * offending variable named.
 *
 * @param schema - The producer's environment schema.
 * @param source - The variables to read.
 * @returns The parsed configuration.
 * @throws When a variable is missing or invalid.
 */
export function parseEnv<Schema extends z.ZodType>(
	schema: Schema,
	source: NodeJS.ProcessEnv = process.env,
): z.output<Schema> {
	const parsed = schema.safeParse(source);

	if (parsed.success) {
		return parsed.data;
	}

	const issues = parsed.error.issues
		.map((issue) => `  ${issue.path.join('.')}: ${issue.message}`)
		.join('\n');

	throw new Error(`Missing or invalid environment variables:\n${issues}`);
}
