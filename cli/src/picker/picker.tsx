import { Box, Text, useApp, useInput, useWindowSize, type Key } from 'ink';
import { useEffect, useMemo, useReducer } from 'react';
import TextInput from 'ink-text-input';

import type { FilterConfig } from '@telecord/producer-core/config';

import type { Chat, PickerPlatform } from './platforms';
import type { Row } from './rows';

import { pressKey, rowsIn, search, type PickerContext, type PickerModel } from './keys';
import { catalogOf, evaluate, type PickerState } from './model';
import { windowStart } from './rows';

export type PickerProps<Entry extends object> = {
	platform: PickerPlatform<Entry>;
	chats: readonly Chat[];
	initial: PickerState<Entry>;
	filter: FilterConfig;
	/** Called once, with the selection to save or undefined when cancelled, before the picker exits. */
	onDone: (state: PickerState<Entry> | undefined) => void;
};

type Action = { kind: 'key'; input: string; key: Key } | { kind: 'search'; text: string };

// The lines around the list, plus one spare: a frame as tall as the terminal makes Ink clear and redraw the whole screen.
const CHROME_LINES = 6;

const LIST_KEYS =
	'↑↓ PgUp PgDn move · Space tick · a all · n none · d default · m DMs · Tab search · s save · q cancel';

const SEARCH_KEYS = 'Type to search · Esc clear · Tab/Enter/↓ list · Ctrl+C cancel';

function mark(ticked: number, total: number): string {
	if (ticked === 0) {
		return '[ ]';
	}

	return ticked === total ? '[x]' : '[-]';
}

function Picker<Entry extends object>({
	platform,
	chats,
	initial,
	filter,
	onDone,
}: PickerProps<Entry>) {
	const { exit } = useApp();
	const { rows: screenRows } = useWindowSize();
	const catalog = useMemo(() => catalogOf(chats, platform), [chats, platform]);
	const groups = useMemo(() => platform.groups(chats), [chats, platform]);
	const height = Math.max(1, screenRows - CHROME_LINES - (filter.rules === undefined ? 0 : 1));
	const context: PickerContext<Entry> = { platform, catalog, groups, height };
	// Keys are reduced rather than handled against this render's state, since one input chunk can
	// hold several keys that all arrive before the next render.
	const [model, dispatch] = useReducer(
		(current: PickerModel<Entry>, action: Action) =>
			action.kind === 'key'
				? pressKey(context, current, action.input, action.key)
				: search(current, action.text),
		{ selection: initial, search: '', focus: 'list', cursor: 0, start: 0 },
	);
	const { selection, focus, result } = model;
	const evaluation = useMemo(
		() => evaluate(selection, platform, catalog, filter),
		[selection, platform, catalog, filter],
	);
	// The rows depend on the search and the selection only, not on cursor moves.
	const rows = useMemo(
		() => rowsIn(context, model),
		[platform, catalog, groups, model.search, selection],
	);
	const cursor = Math.min(model.cursor, Math.max(0, rows.length - 1));
	const start = windowStart(cursor, height, rows.length, model.start);

	useInput((input, key) => dispatch({ kind: 'key', input, key }));

	useEffect(() => {
		if (result !== undefined) {
			onDone(result.saved);
			exit();
		}
	}, [result, onDone, exit]);

	function tickedCount(rowChats: readonly Chat[]): number {
		return rowChats.filter((chat) => evaluation.ticked.has(chat)).length;
	}

	function renderRow(row: Row<Entry>, index: number) {
		const pointer = index === cursor && focus === 'list' ? '›' : ' ';

		switch (row.kind) {
			case 'group': {
				const ticked = tickedCount(row.chats);

				return (
					<Text key={`group:${row.label}:${index}`} bold wrap='truncate-end'>
						{`${pointer} ${mark(ticked, row.chats.length)} ${row.label} (${ticked}/${row.chats.length})`}
					</Text>
				);
			}

			case 'heading': {
				return (
					<Text key={`heading:${index}`} bold color='yellow' wrap='truncate-end'>
						{`${pointer} ${row.label}`}
					</Text>
				);
			}

			case 'chat': {
				const ticked = evaluation.ticked.has(row.chat);

				return (
					<Text key={`chat:${row.chat.id}`} wrap='truncate-end'>
						{`${pointer}   ${mark(ticked ? 1 : 0, 1)} ${row.chat.name}`}
						{evaluation.overridden.has(row.chat) ? (
							<Text color='yellow'>
								{` (filter.rules ${ticked ? 'hide' : 'forward'} it)`}
							</Text>
						) : undefined}
					</Text>
				);
			}

			case 'stale': {
				const { action, entry } = row.listing;
				const name = 'name' in entry && typeof entry.name === 'string' ? entry.name : '';

				return (
					<Text key={`stale:${index}`} color='yellow' wrap='truncate-end'>
						{`${pointer}   ! ${name} ${platform.forward.targetOf(entry).id} (${action})`}
					</Text>
				);
			}
		}
	}

	return (
		<Box flexDirection='column'>
			<Text bold wrap='truncate-end'>
				{`${platform.label}: ${evaluation.forwarded} of ${chats.length} chats forwarded`}
			</Text>
			<Text wrap='truncate-end'>
				{`Unlisted chats: ${selection.default === 'allow' ? 'forward' : 'hide'} (d) · Unlisted DMs: ${selection.dms ? 'forward' : 'hide'} (m)`}
			</Text>
			{filter.rules === undefined ? undefined : (
				<Text color='yellow' wrap='truncate-end'>
					config.toml has filter.rules: they are evaluated first and may override these
					ticks.
				</Text>
			)}
			<Box>
				<Text color={focus === 'search' ? 'cyan' : undefined}>Search: </Text>
				<TextInput
					value={model.search}
					focus={focus === 'search'}
					showCursor={focus === 'search'}
					placeholder={focus === 'search' ? '' : 'Tab or / to search'}
					onChange={(text) => dispatch({ kind: 'search', text })}
				/>
			</Box>
			<Box flexDirection='column' height={height}>
				{rows.length === 0 ? (
					<Text dimColor>No chats match.</Text>
				) : (
					rows
						.slice(start, start + height)
						.map((row, offset) => renderRow(row, start + offset))
				)}
			</Box>
			<Text dimColor wrap='truncate-end'>
				{`${rows.length === 0 ? 0 : cursor + 1}/${rows.length}`}
			</Text>
			<Text dimColor wrap='truncate-end'>
				{focus === 'list' ? LIST_KEYS : SEARCH_KEYS}
			</Text>
		</Box>
	);
}

export default Picker;
