import type { Chat, ChatGroup } from './platforms';
import type { Listing } from './model';

const STALE_LABEL = 'Not in this account, kept as listed';

/** A line of the picker's list. */
export type Row<Entry extends object> =
	| { kind: 'group'; label: string; chats: readonly Chat[] }
	| { kind: 'heading'; label: string }
	| { kind: 'chat'; chat: Chat }
	| { kind: 'stale'; listing: Listing<Entry> };

function includes(text: string, query: string): boolean {
	return text.toLowerCase().includes(query);
}

/**
 * The picker's lines for a search: each group heading the chats that match,
 * all of a group's when its heading does, then the stale listings that match.
 *
 * @param groups - The account's chats, grouped.
 * @param stale - The listings the account no longer has.
 * @param search - What was typed, matched case-insensitively against names and ids.
 * @returns The lines, a group's chats after its heading.
 */
export function rowsOf<Entry extends object>(
	groups: readonly ChatGroup[],
	stale: readonly Listing<Entry>[],
	search: string,
): Row<Entry>[] {
	const query = search.trim().toLowerCase();
	const staleShown = stale.filter(({ entry }) =>
		Object.values(entry).some((value) => typeof value === 'string' && includes(value, query)),
	);

	return [
		...groups.flatMap(({ label, chats }): Row<Entry>[] => {
			const shown = includes(label, query)
				? chats
				: chats.filter((chat) => includes(chat.name, query) || includes(chat.id, query));

			return shown.length === 0
				? []
				: [
						{ kind: 'group', label, chats: shown },
						...shown.map((chat) => ({ kind: 'chat' as const, chat })),
					];
		}),
		...(staleShown.length === 0
			? []
			: [
					{ kind: 'heading' as const, label: STALE_LABEL },
					...staleShown.map((listing) => ({ kind: 'stale' as const, listing })),
				]),
	];
}

/**
 * The first line shown of a list scrolled just far enough to show the cursor.
 *
 * @param cursor - The line the cursor is on.
 * @param height - How many lines fit.
 * @param total - How many lines there are.
 * @param previous - The first line shown before the cursor moved.
 * @returns The first line to show.
 */
export function windowStart(
	cursor: number,
	height: number,
	total: number,
	previous: number,
): number {
	const start = cursor < previous ? cursor : Math.max(previous, cursor - height + 1);

	return Math.max(0, Math.min(start, total - height));
}
