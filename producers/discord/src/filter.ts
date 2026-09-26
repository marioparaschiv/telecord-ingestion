import { z } from 'zod';

import {
	DISCORD_FORWARDED_DISPATCHES,
	type DiscordForwardedDispatch,
} from '@telecord/ingest-client/discord';

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

/** DMs and group DMs are dropped unless the rules say otherwise. */
export const DEFAULT_DISCORD_FILTER_RULES = [{ action: 'deny', type: ['dm', 'group_dm'] }];
