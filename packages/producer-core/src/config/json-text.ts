import { z } from 'zod';

/** A setting's value as TOML gives it, or as the JSON text its environment variable holds. */
const JsonTextSchema = z.unknown().transform((raw, context) => {
	if (typeof raw !== 'string') {
		return raw;
	}

	try {
		return JSON.parse(raw);
	} catch (error) {
		context.addIssue({ code: 'custom', message: `Not JSON: ${String(error)}` });

		return z.NEVER;
	}
});

export default JsonTextSchema;
