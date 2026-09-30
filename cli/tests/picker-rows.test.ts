import { describe, expect, it } from 'vitest';

import { DISCORD_PICKER, TELEGRAM_PICKER, type Chat } from '../src/picker/platforms';
import { rowsOf, windowStart } from '../src/picker/rows';

const news: Chat = { id: '-1001', name: 'News', type: 'channel' };
const family: Chat = { id: '-5', name: 'Family', type: 'group' };
const alice: Chat = { id: '42', name: 'Alice', type: 'user' };
const newsletter: Chat = { id: '-1003', name: 'Newsletter', type: 'channel' };

const general: Chat = {
	id: '101',
	name: 'general',
	type: 'guild',
	guildId: '100',
	guildName: 'Gaming',
};
const news2: Chat = { id: '201', name: 'news', type: 'guild', guildId: '200', guildName: 'Work' };
const bob: Chat = { id: '301', name: 'bob', type: 'dm' };

describe('platform groups', () => {
	it('groups Telegram chats as channels, groups, then DMs', () => {
		expect(TELEGRAM_PICKER.groups([alice, news, family, newsletter])).toEqual([
			{ label: 'Channels', chats: [news, newsletter] },
			{ label: 'Groups', chats: [family] },
			{ label: 'DMs', chats: [alice] },
		]);
	});

	it('groups Discord chats by server, then DMs', () => {
		expect(DISCORD_PICKER.groups([bob, general, news2])).toEqual([
			{ label: 'Gaming', chats: [general] },
			{ label: 'Work', chats: [news2] },
			{ label: 'DMs', chats: [bob] },
		]);
	});
});

describe('rowsOf', () => {
	const groups = TELEGRAM_PICKER.groups([news, family, alice, newsletter]);

	it('lists every group heading its chats without a search', () => {
		expect(rowsOf(groups, [], '').map((row) => row.kind)).toEqual([
			'group',
			'chat',
			'chat',
			'group',
			'chat',
			'group',
			'chat',
		]);
	});

	it('narrows to the chats matching the search, case-insensitively', () => {
		expect(rowsOf(groups, [], ' NEWS')).toEqual([
			{ kind: 'group', label: 'Channels', chats: [news, newsletter] },
			{ kind: 'chat', chat: news },
			{ kind: 'chat', chat: newsletter },
		]);
		expect(rowsOf(groups, [], '42')).toEqual([
			{ kind: 'group', label: 'DMs', chats: [alice] },
			{ kind: 'chat', chat: alice },
		]);
	});

	it('shows every chat of a group whose heading matches', () => {
		const discord = DISCORD_PICKER.groups([general, news2, bob]);

		expect(rowsOf(discord, [], 'gam')).toEqual([
			{ kind: 'group', label: 'Gaming', chats: [general] },
			{ kind: 'chat', chat: general },
		]);
	});

	it('lists the stale listings last, under their own heading', () => {
		const stale = { action: 'allow' as const, entry: { id: '-1009', name: 'Gone' } };

		expect(rowsOf(groups, [stale], 'gone')).toEqual([
			{ kind: 'heading', label: 'Not in this account, kept as listed' },
			{ kind: 'stale', listing: stale },
		]);
		expect(rowsOf(groups, [stale], 'news').some((row) => row.kind === 'stale')).toBe(false);
	});
});

describe('windowStart', () => {
	it('keeps the window while the cursor stays inside it', () => {
		expect(windowStart(5, 10, 100, 0)).toBe(0);
		expect(windowStart(12, 10, 100, 5)).toBe(5);
	});

	it('scrolls just far enough to show the cursor', () => {
		expect(windowStart(10, 10, 100, 0)).toBe(1);
		expect(windowStart(3, 10, 100, 5)).toBe(3);
		expect(windowStart(99, 10, 100, 0)).toBe(90);
	});

	it('pulls the window back when the list shrinks', () => {
		expect(windowStart(2, 10, 4, 50)).toBe(0);
		expect(windowStart(15, 10, 20, 12)).toBe(10);
	});
});
