import { z } from 'zod';

import JsonTextSchema from './config/json-text';

export const FilterActionSchema = z.enum(['allow', 'deny']);

export type FilterAction = z.output<typeof FilterActionSchema>;

/** What a rule is matched against: an event, a chat in a snapshot, or the chat a request names. */
type FilterSubject = Readonly<Partial<Record<string, string>>>;

/** Every listed field must hold one of its values; an empty match matches everything. */
export type FilterMatch = Readonly<Partial<Record<string, readonly string[]>>>;

export type FilterRule = {
	action: FilterAction;
	match: FilterMatch;
};

export type Filter = {
	rules: readonly FilterRule[];
	/** The action when no rule matches. */
	fallback: FilterAction;
};

/** The `filter` table as configured: its rules are unset when the producer's defaults apply. */
export type FilterConfig = {
	rules: readonly FilterRule[] | undefined;
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
 * The `filter` table of a producer's config: `rules`, a TOML array of tables or
 * the JSON list `FILTER_RULES` holds, and `default`, the action when no rule matches.
 *
 * @param fields - The subject fields a rule may match on.
 * @returns The table's schema.
 */
export function createFilterConfigSchema(fields: Record<string, z.ZodType<string>>) {
	return z
		.object({
			rules: JsonTextSchema.pipe(createFilterRulesSchema(fields)).optional().meta({
				env: 'FILTER_RULES',
				description:
					'The ordered rules; the first one matching a chat or event decides. JSON in the environment.',
			}),
			default: FilterActionSchema.default('allow').meta({
				env: 'FILTER_DEFAULT',
				description: 'The action, allow or deny, when no rule matches.',
			}),
		})
		.transform(({ rules, default: fallback }): FilterConfig => ({ rules, fallback }));
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
