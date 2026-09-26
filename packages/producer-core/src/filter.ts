import { z } from 'zod';

const FilterActionSchema = z.enum(['allow', 'deny']);

type FilterAction = z.output<typeof FilterActionSchema>;

/** What a rule is matched against: an event, a chat in a snapshot, or the chat a request names. */
type FilterSubject = Readonly<Partial<Record<string, string>>>;

type FilterRule = {
	action: FilterAction;
	/** Every listed field must hold one of its values; an empty match matches everything. */
	match: Readonly<Partial<Record<string, readonly string[]>>>;
};

export type Filter = {
	rules: readonly FilterRule[];
	/** The action when no rule matches. */
	fallback: FilterAction;
};

/**
 * Builds the schema of an ordered rule list. A rule is flat JSON: its `action`
 * plus any of the producer's subject fields, each a value or a list of values.
 *
 * @param fields - The subject fields a rule may match on, with their value schemas.
 * @returns The rule list schema.
 *
 * @example
 * const schema = createFilterRulesSchema({ peerType: z.enum(['user', 'group', 'channel']) });
 * schema.parse([{ action: 'deny', peerType: 'user' }]);
 */
export function createFilterRulesSchema(fields: Record<string, z.ZodType<string>>) {
	const match = Object.fromEntries(
		Object.entries(fields).map(([name, value]) => [
			name,
			z.union([value.transform((single) => [single]), z.array(value).min(1)]).optional(),
		]),
	);

	return z.array(
		z
			.strictObject({ action: FilterActionSchema, ...match })
			.transform(({ action, ...fields }): FilterRule => ({ action, match: fields })),
	);
}

/**
 * The environment variables that configure a producer's filter: `FILTER_RULES`,
 * a JSON rule list, and `FILTER_DEFAULT`, the action when no rule matches.
 *
 * @param fields - The subject fields a rule may match on.
 * @param defaultRules - The rules used when `FILTER_RULES` is unset.
 * @returns The shape to spread into the producer's environment schema.
 */
export function createFilterEnvShape(
	fields: Record<string, z.ZodType<string>>,
	defaultRules: readonly object[],
) {
	return {
		FILTER_RULES: z
			.string()
			.default(JSON.stringify(defaultRules))
			.transform((raw, context) => {
				try {
					return JSON.parse(raw);
				} catch (error) {
					context.addIssue({ code: 'custom', message: `Not JSON: ${String(error)}` });

					return z.NEVER;
				}
			})
			.pipe(createFilterRulesSchema(fields)),
		FILTER_DEFAULT: FilterActionSchema.default('allow'),
	};
}

function matches({ match }: FilterRule, subject: FilterSubject): boolean {
	return Object.entries(match).every(([field, values]) => {
		const value = subject[field];

		return value !== undefined && values !== undefined && values.includes(value);
	});
}

/**
 * Whether the first rule matching the subject, or the fallback when none does,
 * allows it. A rule naming a field the subject lacks does not match.
 *
 * @param filter - The ordered rules and their fallback.
 * @param subject - The event, chat or request being checked.
 * @returns True when the subject is forwarded or answered.
 */
export function isAllowed(filter: Filter, subject: FilterSubject): boolean {
	const rule = filter.rules.find((candidate) => matches(candidate, subject));

	return (rule?.action ?? filter.fallback) === 'allow';
}
