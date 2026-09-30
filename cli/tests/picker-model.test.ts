import { describe, expect, it } from 'vitest';
import { parse } from 'smol-toml';

import {
	TELEGRAM_FORWARD,
	TelegramConfigSchema,
	TelegramForwardSchema,
} from '@telecord/telegram-producer/config';
import {
	DISCORD_FORWARD,
	DiscordConfigSchema,
	DiscordForwardSchema,
} from '@telecord/discord-producer/config';
import { isAllowed, resolveFilter, type FilterConfig } from '@telecord/producer-core/config';

import {
	catalogOf,
	evaluate,
	forwardOf,
	setChats,
	stateOf,
	staleListings,
} from '../src/picker/model';
import { DISCORD_PICKER, TELEGRAM_PICKER, type Chat } from '../src/picker/platforms';
import { valueAt } from '../src/config-file';
import setTomlValue from '../src/toml-edit';

const NO_RULES: FilterConfig = { rules: undefined, fallback: 'allow' };

const news: Chat = { id: '-1001', name: 'News', type: 'channel' };
const tech: Chat = { id: '-1002', name: 'Tech', type: 'channel' };
const family: Chat = { id: '-5', name: 'Family', type: 'group' };
const alice: Chat = { id: '42', name: 'Alice', type: 'user' };
const telegramChats = [news, tech, family, alice];
const telegramCatalog = catalogOf(telegramChats, TELEGRAM_PICKER);

const general: Chat = {
	id: '101',
	name: 'general',
	type: 'guild',
	guildId: '100',
	guildName: 'Gaming',
};
const memes: Chat = {
	id: '102',
	name: 'memes',
	type: 'guild',
	guildId: '100',
	guildName: 'Gaming',
};
const standup: Chat = {
	id: '201',
	name: 'standup',
	type: 'guild',
	guildId: '200',
	guildName: 'Work',
};
const bob: Chat = { id: '301', name: 'bob', type: 'dm' };
const friends: Chat = { id: '302', name: 'carol, dave', type: 'group_dm' };
const discordChats = [general, memes, standup, bob, friends];
const discordCatalog = catalogOf(discordChats, DISCORD_PICKER);

function discordState(forward: unknown) {
	return stateOf(DiscordForwardSchema.parse(forward), 'allow', DISCORD_PICKER);
}

function telegramState(forward: object) {
	return stateOf(TelegramForwardSchema.parse(forward), 'allow', TELEGRAM_PICKER);
}

describe('stateOf and forwardOf', () => {
	it('round-trips a Telegram table, stale ids and names included', () => {
		const forward = {
			default: 'deny',
			dms: true,
			allow: [{ id: '-1001', name: 'News' }, { id: '-1009' }],
			deny: [{ id: '42', name: 'Alice' }],
		};

		expect(forwardOf(telegramState(forward))).toEqual(forward);
	});

	it('round-trips a Discord table of servers and channels', () => {
		const forward = {
			default: 'allow',
			dms: false,
			allow: [{ channel: '301', name: 'bob' }],
			deny: [
				{ guild: '200', name: 'Work' },
				{ channel: '102', name: '#memes' },
			],
		};

		expect(forwardOf(discordState(forward))).toEqual(forward);
	});

	it('saves as inline lists, one entry per line, that read back as the same table', () => {
		const forward = {
			default: 'allow',
			dms: false,
			deny: [
				{ guild: '200', name: 'Work' },
				{ channel: '102', name: '#memes' },
			],
		};
		const source = setTomlValue(
			'[discord]\ntoken = "t"\n',
			['discord', 'forward'],
			forwardOf(discordState(forward)),
		);

		expect(source).toBe(
			'[discord]\ntoken = "t"\n\n[discord.forward]\ndefault = "allow"\ndms = false\ndeny = [\n\t{ guild = "200", name = "Work" },\n\t{ channel = "102", name = "#memes" },\n]\n',
		);
		expect(forwardOf(discordState(valueAt(parse(source), ['discord', 'forward'])))).toEqual(
			forward,
		);
	});

	it('fills an unset default from filter.default and leaves DMs hidden', () => {
		const state = stateOf(TelegramForwardSchema.parse({}), 'deny', TELEGRAM_PICKER);

		expect(forwardOf(state)).toEqual({ default: 'deny', dms: false });
	});
});

describe('setChats', () => {
	it('lists a chat only where its tick differs from the default', () => {
		const state = telegramState({ default: 'deny' });
		const ticked = setChats(state, TELEGRAM_PICKER, telegramCatalog, [news], true);

		expect(forwardOf(ticked)).toEqual({
			default: 'deny',
			dms: false,
			allow: [{ id: '-1001', name: 'News' }],
		});
		expect(
			forwardOf(setChats(ticked, TELEGRAM_PICKER, telegramCatalog, [news], false)),
		).toEqual({ default: 'deny', dms: false });
		expect(
			forwardOf(
				setChats(
					telegramState({ default: 'allow' }),
					TELEGRAM_PICKER,
					telegramCatalog,
					[news],
					true,
				),
			),
		).toEqual({ default: 'allow', dms: false });
	});

	it('lists DMs against dms rather than the default', () => {
		const shared = setChats(
			telegramState({ default: 'allow', dms: false }),
			TELEGRAM_PICKER,
			telegramCatalog,
			[alice],
			true,
		);
		const hidden = setChats(
			telegramState({ default: 'deny', dms: true }),
			TELEGRAM_PICKER,
			telegramCatalog,
			[alice],
			false,
		);

		expect(forwardOf(shared).allow).toEqual([{ id: '42', name: 'Alice' }]);
		expect(forwardOf(hidden).deny).toEqual([{ id: '42', name: 'Alice' }]);
	});

	it('saves a ticked server as one guild entry, dropping its channel entries', () => {
		const state = discordState({
			default: 'deny',
			allow: [{ channel: '101', name: '#general' }],
		});
		const ticked = setChats(state, DISCORD_PICKER, discordCatalog, [general, memes], true);

		expect(forwardOf(ticked)).toEqual({
			default: 'deny',
			dms: false,
			allow: [{ guild: '100', name: 'Gaming' }],
		});
	});

	it('saves one channel unticked in a ticked server as a channel deny, and drops it when ticked again', () => {
		const server = setChats(
			discordState({ default: 'deny' }),
			DISCORD_PICKER,
			discordCatalog,
			[general, memes],
			true,
		);
		const unticked = setChats(server, DISCORD_PICKER, discordCatalog, [memes], false);

		expect(forwardOf(unticked)).toEqual({
			default: 'deny',
			dms: false,
			allow: [{ guild: '100', name: 'Gaming' }],
			deny: [{ channel: '102', name: '#memes' }],
		});
		expect(
			forwardOf(setChats(unticked, DISCORD_PICKER, discordCatalog, [memes], true)),
		).toEqual(forwardOf(server));
	});

	it('sets part of a server channel by channel', () => {
		const state = setChats(
			discordState({ default: 'deny' }),
			DISCORD_PICKER,
			discordCatalog,
			[general],
			true,
		);

		expect(forwardOf(state).allow).toEqual([{ channel: '101', name: '#general' }]);
	});

	it('selects everything as server entries plus DM entries', () => {
		const state = setChats(
			discordState({ default: 'deny', dms: false }),
			DISCORD_PICKER,
			discordCatalog,
			discordChats,
			true,
		);

		expect(forwardOf(state).allow).toEqual([
			{ guild: '100', name: 'Gaming' },
			{ guild: '200', name: 'Work' },
			{ channel: '301', name: 'bob' },
			{ channel: '302', name: 'carol, dave' },
		]);
		expect(evaluate(state, DISCORD_PICKER, discordCatalog, NO_RULES).ticked).toEqual(
			new Set(discordChats),
		);
	});

	it('keeps the listings the account no longer has', () => {
		const state = telegramState({
			default: 'deny',
			allow: [{ id: '-1009', name: 'Gone' }],
			deny: [{ id: '-7' }],
		});
		const changed = setChats(state, TELEGRAM_PICKER, telegramCatalog, telegramChats, true);

		expect(staleListings(changed, TELEGRAM_PICKER, telegramCatalog)).toEqual([
			{ action: 'allow', entry: { id: '-1009', name: 'Gone' } },
			{ action: 'deny', entry: { id: '-7' } },
		]);
		expect(forwardOf(changed).allow).toContainEqual({ id: '-1009', name: 'Gone' });
		expect(forwardOf(changed).deny).toEqual([{ id: '-7' }]);
	});

	it('finds a server entry for a server the account left stale', () => {
		const state = discordState({ allow: [{ guild: '999', name: 'Left' }, { guild: '100' }] });

		expect(staleListings(state, DISCORD_PICKER, discordCatalog)).toEqual([
			{ action: 'allow', entry: { guild: '999', name: 'Left' } },
		]);
	});
});

describe('evaluate', () => {
	const rules = TelegramConfigSchema.shape.filter.parse({
		rules: [{ action: 'deny', peerId: '-1001' }],
		default: 'allow',
	});

	it('counts the chats the producer forwards, the hand-written rules first', () => {
		const state = telegramState({ default: 'deny', dms: true, allow: [{ id: '-1001' }] });
		const evaluation = evaluate(state, TELEGRAM_PICKER, telegramCatalog, rules);
		const producer = resolveFilter(
			{ filter: rules, forward: forwardOf(state) },
			TELEGRAM_FORWARD,
		);
		const expected = telegramChats.filter((chat) =>
			isAllowed(producer, TELEGRAM_PICKER.subjectOf(chat)),
		);

		expect(evaluation.forwarded).toBe(expected.length);
		expect(evaluation.forwarded).toBe(1);
		expect(evaluation.ticked).toEqual(new Set([news, alice]));
		expect(evaluation.overridden).toEqual(new Set([news]));
	});

	it('matches the Discord producer for a server with a channel carved out', () => {
		const state = discordState({
			default: 'deny',
			dms: true,
			allow: [{ guild: '100' }],
			deny: [{ channel: '102' }, { channel: '302' }],
		});
		const filter = DiscordConfigSchema.shape.filter.parse({});
		const producer = resolveFilter({ filter, forward: forwardOf(state) }, DISCORD_FORWARD);
		const evaluation = evaluate(state, DISCORD_PICKER, discordCatalog, filter);

		expect(evaluation.ticked).toEqual(new Set([general, bob]));
		expect(evaluation.forwarded).toBe(
			discordChats.filter((chat) => isAllowed(producer, DISCORD_PICKER.subjectOf(chat)))
				.length,
		);
		expect(evaluation.overridden.size).toBe(0);
	});

	it('flips the unlisted chats when the default flips', () => {
		const state = telegramState({ default: 'deny', deny: [{ id: '-1002' }] });

		expect(evaluate(state, TELEGRAM_PICKER, telegramCatalog, NO_RULES).forwarded).toBe(0);
		expect(
			evaluate({ ...state, default: 'allow' }, TELEGRAM_PICKER, telegramCatalog, NO_RULES)
				.ticked,
		).toEqual(new Set([news, family]));
	});
});
