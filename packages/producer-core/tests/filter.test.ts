import { describe, expect, it } from 'vitest';
import { z } from 'zod';

import { createFilterConfigSchema, createFilterRulesSchema, isAllowed } from '../src/filter';

const fields = {
	type: z.enum(['dm', 'group_dm', 'guild']),
	guildId: z.string(),
	channelId: z.string(),
	event: z.string(),
};

const RulesSchema = createFilterRulesSchema(fields);
const ConfigSchema = createFilterConfigSchema(fields);

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

	it('leaves the rules unset when none are configured', () => {
		expect(ConfigSchema.parse({})).toEqual({ rules: undefined, fallback: 'allow' });
	});

	it('fails loudly on rules that are not JSON', () => {
		const parsed = ConfigSchema.safeParse({ rules: '[{action: deny}]' });

		expect(parsed.success).toBe(false);
		expect(parsed.error?.issues[0]?.message).toMatch(/^Not JSON/);
	});
});
