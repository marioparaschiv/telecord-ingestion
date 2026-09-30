import { z } from 'zod';

import {
	FilterActionSchema,
	type Filter,
	type FilterAction,
	type FilterConfig,
	type FilterMatch,
	type FilterRule,
} from './filter';
import JsonTextSchema from './config/json-text';

/** The filter field a `forward` entry matches and the id it holds there. */
export type ForwardTarget = {
	field: string;
	id: string;
};

/** How a producer's `forward` entries read and become filter rules. */
export type ForwardPlatform<Entry extends object> = {
	entry: z.ZodType<Entry>;
	/** The fields entries target, most specific first: a channel's entry overrides its server's. */
	fields: readonly string[];
	targetOf: (entry: Entry) => ForwardTarget;
	/** Matches every DM. */
	dms: FilterMatch;
};

/** The `forward` table as configured; every key unset means there is no table. */
export type ForwardConfig<Entry extends object> = {
	default?: FilterAction | undefined;
	dms?: boolean | undefined;
	allow?: readonly Entry[] | undefined;
	deny?: readonly Entry[] | undefined;
};

/**
 * The `forward` table of a producer's config, the one the chat picker writes:
 * `allow` and `deny` list chats, `dms` shares DMs, and `default` decides the
 * chats neither list names. A chat listed in both lists is refused.
 *
 * @param platform - The producer's entry shape and how an entry targets a filter field.
 * @returns The table's schema.
 */
export function createForwardConfigSchema<Entry extends object>(platform: ForwardPlatform<Entry>) {
	const entries = JsonTextSchema.pipe(z.array(platform.entry)).optional();

	return z
		.object({
			default: FilterActionSchema.optional().meta({
				env: 'FORWARD_DEFAULT',
				description:
					'The action, allow or deny, for the chats neither list names. Unset leaves filter.default.',
			}),
			dms: z.union([z.boolean(), z.stringbool()]).optional().meta({
				env: 'FORWARD_DMS',
				description:
					'Whether DMs are shared. A DM listed in allow or deny follows its list.',
			}),
			allow: entries.meta({
				env: 'FORWARD_ALLOW',
				description: 'The chats to share. JSON in the environment.',
			}),
			deny: entries.meta({
				env: 'FORWARD_DENY',
				description: 'The chats to hide. JSON in the environment.',
			}),
		})
		.superRefine(({ allow = [], deny = [] }, context) => {
			const allowed = new Set(allow.map((entry) => targetKey(platform.targetOf(entry))));

			for (const [index, entry] of deny.entries()) {
				const target = platform.targetOf(entry);

				if (allowed.has(targetKey(target))) {
					context.addIssue({
						code: 'custom',
						path: ['deny', index],
						message: `${target.id} is listed in both forward.allow and forward.deny`,
					});
				}
			}
		});
}

/**
 * The key a target is compared by: entries target the same chat or server when their keys match.
 *
 * @param target - The field and id an entry targets.
 * @returns The key.
 */
export function targetKey({ field, id }: ForwardTarget): string {
	return `${field}:${id}`;
}

function entryRules<Entry extends object>(
	forward: ForwardConfig<Entry>,
	{ fields, targetOf }: ForwardPlatform<Entry>,
): FilterRule[] {
	return fields.flatMap((field) =>
		(['deny', 'allow'] as const).flatMap((action) => {
			const ids = (forward[action] ?? [])
				.map(targetOf)
				.filter((target) => target.field === field)
				.map(({ id }) => id);

			return ids.length === 0 ? [] : [{ action, match: { [field]: ids } }];
		}),
	);
}

/**
 * The filter a producer runs with. Without a `forward` table, the configured
 * rules or else the producer's default of denying DMs. With one, the configured
 * rules come first, then the listed chats, most specific field first, then one
 * rule allowing or denying every DM as `dms` says, so a listed DM keeps its
 * list's action and no other entry reaches DMs. `forward.default`, when set,
 * replaces `filter.default` as the fallback.
 *
 * @param config - The producer's `filter` and `forward` tables.
 * @param platform - How the producer's `forward` entries become filter rules.
 * @returns The ordered rules and their fallback.
 */
export function resolveFilter<Entry extends object>(
	{ filter, forward }: { filter: FilterConfig; forward: ForwardConfig<Entry> },
	platform: ForwardPlatform<Entry>,
): Filter {
	if (Object.values(forward).every((value) => value === undefined)) {
		return {
			rules: filter.rules ?? [{ action: 'deny', match: platform.dms }],
			fallback: filter.fallback,
		};
	}

	return {
		rules: [
			...(filter.rules ?? []),
			...entryRules(forward, platform),
			{ action: forward.dms === true ? 'allow' : 'deny', match: platform.dms },
		],
		fallback: forward.default ?? filter.fallback,
	};
}
