import { z } from 'zod';

import {
	DISCORD_FORWARDED_DISPATCHES,
	type DiscordForwardedDispatch,
} from '@telecord/ingest-client/discord';
import type { ForwardPlatform } from '@telecord/producer-core/config';

export const CHAT_TYPES = ['dm', 'group_dm', 'guild'] as const;

export type ChatType = (typeof CHAT_TYPES)[number];

/** What the filter rules see of a dispatch, a snapshot chat or a request's channel. */
export type DiscordFilterSubject = {
	type?: ChatType;
	guildId?: string;
	channelId?: string;
	/** The dispatch name, for events only. */
	event?: DiscordForwardedDispatch;
};

const SnowflakeSchema = z.string().regex(/^\d+$/);

export const DISCORD_FILTER_FIELDS = {
	type: z.enum(CHAT_TYPES),
	guildId: SnowflakeSchema,
	channelId: SnowflakeSchema,
	event: z.enum(DISCORD_FORWARDED_DISPATCHES),
};

const ForwardNameSchema = z.string().optional();

/**
 * A server or a channel in `forward.allow` or `forward.deny`, DMs being
 * channels; `name` is for the reader only.
 */
const DiscordForwardEntrySchema = z.union([
	z.strictObject({ guild: SnowflakeSchema, name: ForwardNameSchema }),
	z.strictObject({ channel: SnowflakeSchema, name: ForwardNameSchema }),
]);

export type DiscordForwardEntry = z.output<typeof DiscordForwardEntrySchema>;

/** DMs and group DMs are dropped unless the rules or the `forward` table say otherwise. */
export const DISCORD_FORWARD: ForwardPlatform<DiscordForwardEntry> = {
	entry: DiscordForwardEntrySchema,
	fields: ['channelId', 'guildId'],
	targetOf: (entry) =>
		'channel' in entry
			? { field: 'channelId', id: entry.channel }
			: { field: 'guildId', id: entry.guild },
	dms: { type: ['dm', 'group_dm'] },
};
