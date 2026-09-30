import { describe, expect, it } from 'vitest';

import {
	pressKey,
	rowsIn,
	search,
	type KeyPress,
	type PickerContext,
	type PickerModel,
} from '../src/picker/keys';
import { TELEGRAM_PICKER, type Chat } from '../src/picker/platforms';
import { catalogOf, forwardOf, stateOf } from '../src/picker/model';

const news: Chat = { id: '-1001', name: 'News', type: 'channel' };
const newsletter: Chat = { id: '-1003', name: 'Newsletter', type: 'channel' };
const family: Chat = { id: '-5', name: 'Family', type: 'group' };
const alice: Chat = { id: '42', name: 'Alice', type: 'user' };
const chats = [news, newsletter, family, alice];

type TelegramModel = PickerModel<{ id: string; name?: string }>;

const context: PickerContext<{ id: string; name?: string }> = {
	platform: TELEGRAM_PICKER,
	catalog: catalogOf(chats, TELEGRAM_PICKER),
	groups: TELEGRAM_PICKER.groups(chats),
	height: 3,
};

const initial: TelegramModel = {
	selection: stateOf({ default: 'deny' }, 'allow', TELEGRAM_PICKER),
	search: '',
	focus: 'list',
	cursor: 0,
	start: 0,
};

const DOWN: KeyPress = { downArrow: true };
const TAB: KeyPress = { tab: true };

function press(model: TelegramModel, ...keys: (string | KeyPress)[]): TelegramModel {
	return keys.reduce<TelegramModel>(
		(current, key) =>
			typeof key === 'string'
				? pressKey(context, current, key, {})
				: pressKey(context, current, '', key),
		model,
	);
}

describe('pressKey', () => {
	it('applies keys that arrive together one after another', () => {
		const searched = search(press(initial, TAB), 'news');
		const model = press(searched, TAB, DOWN, ' ', 's');

		expect(model.focus).toBe('list');
		expect(model.cursor).toBe(1);
		expect(model.result?.saved && forwardOf(model.result.saved)).toEqual({
			default: 'deny',
			dms: false,
			allow: [{ id: '-1001', name: 'News' }],
		});
	});

	it('ticks a whole group from its heading, and unticks it when all are ticked', () => {
		const ticked = press(initial, ' ');

		expect(forwardOf(ticked.selection).allow).toEqual([
			{ id: '-1001', name: 'News' },
			{ id: '-1003', name: 'Newsletter' },
		]);
		expect(forwardOf(press(ticked, ' ').selection).allow).toBeUndefined();
	});

	it('selects all and none of the chats the search shows', () => {
		const all = press(search(initial, 'i'), 'a');

		expect(forwardOf(all.selection).allow).toEqual([
			{ id: '-5', name: 'Family' },
			{ id: '42', name: 'Alice' },
		]);
		expect(forwardOf(press(all, 'n').selection).allow).toBeUndefined();
	});

	it('toggles the default and DMs', () => {
		const model = press(initial, 'd', 'm');

		expect(model.selection.default).toBe('allow');
		expect(model.selection.dms).toBe(true);
	});

	it('scrolls the window with the cursor and clamps it to the rows', () => {
		const bottom = press(initial, { end: true });
		const total = rowsIn(context, initial).length;

		expect(bottom.cursor).toBe(total - 1);
		expect(bottom.start).toBe(total - context.height);
		expect(press(bottom, DOWN).cursor).toBe(total - 1);
		expect(press(bottom, { pageUp: true }).cursor).toBe(total - 1 - context.height);
		expect(press(bottom, { home: true })).toMatchObject({ cursor: 0, start: 0 });
	});

	it('types letters into the search rather than running shortcuts', () => {
		const model = press(initial, '/', 'a', 's', 'q');

		expect(model.focus).toBe('search');
		expect(model.result).toBeUndefined();
		expect(model.selection).toBe(initial.selection);
	});

	it('clears the search on Escape', () => {
		const model = press(
			{ ...search(initial, 'news'), focus: 'search', cursor: 2 },
			{
				escape: true,
			},
		);

		expect(model).toMatchObject({ search: '', cursor: 0, focus: 'search' });
	});

	it('cancels on q in the list and on Ctrl+C anywhere', () => {
		expect(press(initial, 'q').result).toEqual({ saved: undefined });
		expect(
			pressKey(context, { ...initial, focus: 'search' }, 'c', { ctrl: true }).result,
		).toEqual({ saved: undefined });
	});
});
