import {
	isAllowed,
	resolveFilter,
	targetKey,
	type Filter,
	type FilterAction,
	type FilterConfig,
	type ForwardConfig,
} from '@telecord/producer-core/config';

import type { Chat, PickerPlatform } from './platforms';

/** A chat or server the `forward` table lists, and the list it is in. */
export type Listing<Entry extends object> = {
	action: FilterAction;
	entry: Entry;
};

/** The picker's selection: the `forward` table, its entries keyed by what they target. */
export type PickerState<Entry extends object> = {
	default: FilterAction;
	dms: boolean;
	/** In the order they are written back. */
	listings: ReadonlyMap<string, Listing<Entry>>;
};

type Guild<Entry extends object> = {
	key: string;
	entry: Entry;
	chats: readonly Chat[];
};

/** The account's chats and the servers they belong to. */
export type Catalog<Entry extends object> = {
	chats: readonly Chat[];
	guilds: readonly Guild<Entry>[];
};

/** How the picker shows the account's chats under a selection. */
export type Evaluation = {
	/** The chats the `forward` table alone forwards. */
	ticked: ReadonlySet<Chat>;
	/** How many chats the producer forwards, the hand-written rules applied first. */
	forwarded: number;
	/** The chats the hand-written rules decide against their tick. */
	overridden: ReadonlySet<Chat>;
};

function listingKey<Entry extends object>(platform: PickerPlatform<Entry>, entry: Entry): string {
	return targetKey(platform.forward.targetOf(entry));
}

function chatKey<Entry extends object>(platform: PickerPlatform<Entry>, chat: Chat): string {
	return listingKey(platform, platform.chatEntry(chat));
}

/**
 * Gathers the servers the account's chats belong to.
 *
 * @param chats - The account's chats.
 * @param platform - The producer.
 * @returns The catalog.
 */
export function catalogOf<Entry extends object>(
	chats: readonly Chat[],
	platform: PickerPlatform<Entry>,
): Catalog<Entry> {
	const { guildEntry } = platform;

	if (guildEntry === undefined) {
		return { chats, guilds: [] };
	}

	const byGuild = Map.groupBy(
		chats.filter((chat) => chat.guildId !== undefined),
		(chat) => chat.guildId ?? '',
	);

	return {
		chats,
		guilds: [...byGuild].map(([id, guildChats]) => {
			const entry = guildEntry(id, guildChats[0].guildName ?? id);

			return { key: listingKey(platform, entry), entry, chats: guildChats };
		}),
	};
}

/**
 * The picker's selection from a `forward` table. A table that leaves `default`
 * or `dms` unset gets the values the producer runs with.
 *
 * @param forward - The table as configured.
 * @param fallback - The `filter.default` the producer falls back to without `forward.default`.
 * @param platform - The producer.
 * @returns The selection.
 */
export function stateOf<Entry extends object>(
	forward: ForwardConfig<Entry>,
	fallback: FilterAction,
	platform: PickerPlatform<Entry>,
): PickerState<Entry> {
	const listings = new Map<string, Listing<Entry>>();

	for (const action of ['allow', 'deny'] as const) {
		for (const entry of forward[action] ?? []) {
			listings.set(listingKey(platform, entry), { action, entry });
		}
	}

	return { default: forward.default ?? fallback, dms: forward.dms ?? false, listings };
}

/**
 * The `forward` table a selection saves as. Empty lists are left out.
 *
 * @param state - The selection.
 * @returns The table.
 */
export function forwardOf<Entry extends object>(state: PickerState<Entry>): ForwardConfig<Entry> {
	const listings = [...state.listings.values()];
	const allow = listings.filter(({ action }) => action === 'allow').map(({ entry }) => entry);
	const deny = listings.filter(({ action }) => action === 'deny').map(({ entry }) => entry);

	return {
		default: state.default,
		dms: state.dms,
		...(allow.length > 0 && { allow }),
		...(deny.length > 0 && { deny }),
	};
}

function tickFilter<Entry extends object>(
	state: PickerState<Entry>,
	platform: PickerPlatform<Entry>,
): Filter {
	return resolveFilter(
		{ filter: { rules: [], fallback: state.default }, forward: forwardOf(state) },
		platform.forward,
	);
}

/**
 * Whether the `forward` table alone forwards every one of the chats.
 *
 * @param state - The selection.
 * @param platform - The producer.
 * @param chats - The chats.
 * @returns True when they are all ticked.
 */
export function allTicked<Entry extends object>(
	state: PickerState<Entry>,
	platform: PickerPlatform<Entry>,
	chats: readonly Chat[],
): boolean {
	const ticks = tickFilter(state, platform);

	return chats.every((chat) => isAllowed(ticks, platform.subjectOf(chat)));
}

/**
 * Evaluates a selection with the rules the producer compiles from it.
 *
 * @param state - The selection.
 * @param platform - The producer.
 * @param catalog - The account's chats.
 * @param filter - The `filter` table, whose rules go before the `forward` table's.
 * @returns The ticked chats, the forwarded count and the chats the rules override.
 */
export function evaluate<Entry extends object>(
	state: PickerState<Entry>,
	platform: PickerPlatform<Entry>,
	catalog: Catalog<Entry>,
	filter: FilterConfig,
): Evaluation {
	const ticks = tickFilter(state, platform);
	const producer = resolveFilter({ filter, forward: forwardOf(state) }, platform.forward);
	const ticked = new Set<Chat>();
	const overridden = new Set<Chat>();
	let forwarded = 0;

	for (const chat of catalog.chats) {
		const subject = platform.subjectOf(chat);
		const tick = isAllowed(ticks, subject);
		const forwards = isAllowed(producer, subject);

		if (tick) {
			ticked.add(chat);
		}

		if (forwards) {
			forwarded += 1;
		}

		if (tick !== forwards) {
			overridden.add(chat);
		}
	}

	return { ticked, forwarded, overridden };
}

/**
 * Ticks or unticks chats, listing each one only where what it inherits
 * differs. A server whose every channel is among the chats is set as one
 * server entry and its channels' entries dropped, so a channel later unticked
 * alone is listed against it.
 *
 * @param state - The selection.
 * @param platform - The producer.
 * @param catalog - The account's chats.
 * @param chats - The chats to set.
 * @param forwarded - Whether they are forwarded.
 * @returns The new selection.
 */
export function setChats<Entry extends object>(
	state: PickerState<Entry>,
	platform: PickerPlatform<Entry>,
	catalog: Catalog<Entry>,
	chats: readonly Chat[],
	forwarded: boolean,
): PickerState<Entry> {
	const given = new Set(chats);
	const wholeGuilds = catalog.guilds.filter((guild) =>
		guild.chats.every((chat) => given.has(chat)),
	);
	const listings = new Map(state.listings);
	const action = forwarded ? 'allow' : 'deny';

	for (const chat of chats) {
		listings.delete(chatKey(platform, chat));
	}

	for (const guild of wholeGuilds) {
		listings.delete(guild.key);
	}

	const inherited = tickFilter({ ...state, listings }, platform);

	for (const guild of wholeGuilds) {
		if (isAllowed(inherited, platform.subjectOf(guild.chats[0])) !== forwarded) {
			listings.set(guild.key, { action, entry: guild.entry });
		}
	}

	const withGuilds = tickFilter({ ...state, listings }, platform);

	for (const chat of chats) {
		if (isAllowed(withGuilds, platform.subjectOf(chat)) !== forwarded) {
			listings.set(chatKey(platform, chat), { action, entry: platform.chatEntry(chat) });
		}
	}

	return { ...state, listings };
}

/**
 * The listings naming chats or servers the account no longer has. They are
 * kept on save.
 *
 * @param state - The selection.
 * @param platform - The producer.
 * @param catalog - The account's chats.
 * @returns The stale listings, in table order.
 */
export function staleListings<Entry extends object>(
	state: PickerState<Entry>,
	platform: PickerPlatform<Entry>,
	catalog: Catalog<Entry>,
): Listing<Entry>[] {
	const known = new Set([
		...catalog.chats.map((chat) => chatKey(platform, chat)),
		...catalog.guilds.map(({ key }) => key),
	]);

	return [...state.listings].filter(([key]) => !known.has(key)).map(([, listing]) => listing);
}
