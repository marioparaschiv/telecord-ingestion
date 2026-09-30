import type { Key } from 'ink';

import type { Chat, ChatGroup, PickerPlatform } from './platforms';

import { allTicked, setChats, staleListings, type Catalog, type PickerState } from './model';
import { rowsOf, windowStart, type Row } from './rows';

export type Focus = 'search' | 'list';

/** Everything the picker shows, changed a key press at a time. */
export type PickerModel<Entry extends object> = {
	selection: PickerState<Entry>;
	search: string;
	focus: Focus;
	cursor: number;
	/** The first row shown. */
	start: number;
	/** Set once the picker is done, holding the selection to save or undefined when cancelled. */
	result?: { saved: PickerState<Entry> | undefined };
};

/** What the picker works on, fixed while it runs but for the list's height. */
export type PickerContext<Entry extends object> = {
	platform: PickerPlatform<Entry>;
	catalog: Catalog<Entry>;
	groups: readonly ChatGroup[];
	/** How many rows fit. */
	height: number;
};

/** The flags of a key press the picker reads; unset ones are not pressed. */
export type KeyPress = Partial<
	Pick<
		Key,
		| 'upArrow'
		| 'downArrow'
		| 'pageUp'
		| 'pageDown'
		| 'home'
		| 'end'
		| 'tab'
		| 'return'
		| 'escape'
		| 'ctrl'
	>
>;

/**
 * The picker's rows for a model: its search over the account's chats and the
 * stale listings of its selection.
 *
 * @param context - What the picker works on.
 * @param model - The picker's state.
 * @returns The rows.
 */
export function rowsIn<Entry extends object>(
	context: PickerContext<Entry>,
	model: PickerModel<Entry>,
): Row<Entry>[] {
	return rowsOf(
		context.groups,
		staleListings(model.selection, context.platform, context.catalog),
		model.search,
	);
}

function chatsOf<Entry extends object>(row: Row<Entry> | undefined): readonly Chat[] {
	switch (row?.kind) {
		case 'group': {
			return row.chats;
		}

		case 'chat': {
			return [row.chat];
		}

		default: {
			return [];
		}
	}
}

function moveTo<Entry extends object>(
	model: PickerModel<Entry>,
	target: number,
	total: number,
	height: number,
): PickerModel<Entry> {
	const cursor = Math.max(0, Math.min(target, total - 1));

	return { ...model, cursor, start: windowStart(cursor, height, total, model.start) };
}

function setAll<Entry extends object>(
	context: PickerContext<Entry>,
	model: PickerModel<Entry>,
	chats: readonly Chat[],
	forwarded: boolean,
): PickerModel<Entry> {
	return {
		...model,
		selection: setChats(model.selection, context.platform, context.catalog, chats, forwarded),
	};
}

function pressListKey<Entry extends object>(
	context: PickerContext<Entry>,
	model: PickerModel<Entry>,
	input: string,
	key: KeyPress,
): PickerModel<Entry> {
	const { platform, height } = context;
	const { selection, cursor } = model;
	const rows = rowsIn(context, model);

	if (key.upArrow || key.downArrow) {
		return moveTo(model, cursor + (key.upArrow ? -1 : 1), rows.length, height);
	}

	if (key.pageUp || key.pageDown) {
		return moveTo(model, cursor + (key.pageUp ? -height : height), rows.length, height);
	}

	if (key.home || key.end) {
		return moveTo(model, key.home ? 0 : rows.length - 1, rows.length, height);
	}

	switch (input) {
		case '/': {
			return { ...model, focus: 'search' };
		}

		case ' ': {
			const chats = chatsOf(rows[cursor]);

			return setAll(context, model, chats, !allTicked(selection, platform, chats));
		}

		case 'a':
		case 'n': {
			const shown = rows.flatMap((row) => (row.kind === 'chat' ? [row.chat] : []));

			return setAll(context, model, shown, input === 'a');
		}

		case 'd': {
			return {
				...model,
				selection: {
					...selection,
					default: selection.default === 'allow' ? 'deny' : 'allow',
				},
			};
		}

		case 'm': {
			return { ...model, selection: { ...selection, dms: !selection.dms } };
		}

		case 's': {
			return { ...model, result: { saved: selection } };
		}

		case 'q': {
			return { ...model, result: { saved: undefined } };
		}

		default: {
			return model;
		}
	}
}

/**
 * Applies a key press. The search box edits the search itself; here it only
 * hands focus back to the list or clears.
 *
 * @param context - What the picker works on.
 * @param model - The picker's state.
 * @param input - The text the key typed.
 * @param key - The special keys pressed.
 * @returns The new state.
 */
export function pressKey<Entry extends object>(
	context: PickerContext<Entry>,
	model: PickerModel<Entry>,
	input: string,
	key: KeyPress,
): PickerModel<Entry> {
	if (key.ctrl && input === 'c') {
		return { ...model, result: { saved: undefined } };
	}

	if (model.focus === 'list') {
		return key.tab ? { ...model, focus: 'search' } : pressListKey(context, model, input, key);
	}

	if (key.tab || key.return || key.downArrow) {
		return { ...model, focus: 'list' };
	}

	return key.escape ? search(model, '') : model;
}

/**
 * Replaces the search, moving the cursor back to the top.
 *
 * @param model - The picker's state.
 * @param text - The new search.
 * @returns The new state.
 */
export function search<Entry extends object>(
	model: PickerModel<Entry>,
	text: string,
): PickerModel<Entry> {
	return { ...model, search: text, cursor: 0, start: 0 };
}
