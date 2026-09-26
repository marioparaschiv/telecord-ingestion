import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createFilterEnvShape, createFilterRulesSchema, isAllowed } from '../src/filter';

const fields = {
	type: z.enum(['dm', 'group_dm', 'guild']),
	guildId: z.string(),
	channelId: z.string(),
	event: z.string(),
};

const RulesSchema = createFilterRulesSchema(fields);
const EnvSchema = z.object(
	createFilterEnvShape(fields, [{ action: 'deny', type: ['dm', 'group_dm'] }]),
);

describe('filter rules', () => {
	it('parses a single value and a list of values into the same match', () => {
		expect(
			RulesSchema.parse([
				{ action: 'deny', type: 'dm' },
				{ action: 'allow', channelId: ['1', '2'] },
			]),
		).toEqual([
			{ action: 'deny', match: { type: ['dm'] } },
			{ action: 'allow', match: { channelId: ['1', '2'] } },
		]);
	});

	it('rejects a field no subject has', () => {
		expect(RulesSchema.safeParse([{ action: 'deny', peerId: '1' }]).success).toBe(false);
	});

	it('applies the first matching rule, not the most specific one', () => {
		const filter = {
			rules: RulesSchema.parse([
				{ action: 'allow', guildId: '10' },
				{ action: 'deny', guildId: '10', channelId: '11' },
			]),
			fallback: 'deny' as const,
		};

		expect(isAllowed(filter, { type: 'guild', guildId: '10', channelId: '11' })).toBe(true);
		expect(isAllowed(filter, { type: 'guild', guildId: '20', channelId: '21' })).toBe(false);
	});

	it('never matches a rule on a field the subject lacks', () => {
		const filter = {
			rules: RulesSchema.parse([{ action: 'deny', event: 'MESSAGE_DELETE' }]),
			fallback: 'allow' as const,
		};

		expect(isAllowed(filter, { type: 'guild', guildId: '10', event: 'MESSAGE_DELETE' })).toBe(
			false,
		);
		expect(isAllowed(filter, { type: 'guild', guildId: '10' })).toBe(true);
	});

	it('drops DMs and group DMs by default and allows everything else', () => {
		const { FILTER_RULES, FILTER_DEFAULT } = EnvSchema.parse({});
		const filter = { rules: FILTER_RULES, fallback: FILTER_DEFAULT };

		expect(isAllowed(filter, { type: 'dm', channelId: '1' })).toBe(false);
		expect(isAllowed(filter, { type: 'group_dm', channelId: '2' })).toBe(false);
		expect(isAllowed(filter, { type: 'guild', guildId: '3', channelId: '4' })).toBe(true);
	});

	it('replaces the default rules with the configured ones', () => {
		const { FILTER_RULES, FILTER_DEFAULT } = EnvSchema.parse({
			FILTER_RULES: '[{"action":"allow","guildId":"3"}]',
			FILTER_DEFAULT: 'deny',
		});
		const filter = { rules: FILTER_RULES, fallback: FILTER_DEFAULT };

		expect(isAllowed(filter, { type: 'dm', channelId: '1' })).toBe(false);
		expect(isAllowed(filter, { type: 'guild', guildId: '3', channelId: '4' })).toBe(true);
		expect(isAllowed(filter, { type: 'guild', guildId: '5', channelId: '6' })).toBe(false);
	});

	it('fails loudly on rules that are not JSON', () => {
		const parsed = EnvSchema.safeParse({ FILTER_RULES: '[{action: deny}]' });

		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toMatch(/^Not JSON/);
	});
});
