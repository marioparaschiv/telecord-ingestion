import type { Client } from 'discord.js-selfbot-v13';
import { z } from 'zod';

import {
	DISCORD_FORWARDED_DISPATCHES,
	type DiscordForwardedDispatch,
} from '@telecord/ingest-client/discord';
import { isAllowed, type Filter } from '@telecord/producer-core';

import type { DiscordFilterSubject } from './filter';

import { subjectOfChannelId, subjectOfRawChannel } from './channels';

const DispatchSchema = z.object({
	op: z.literal(0),
	t: z.enum(DISCORD_FORWARDED_DISPATCHES),
	d: z.looseObject({}),
});

function optional<T extends z.ZodType>(schema: T) {
	return schema.optional().catch(undefined);
}

/** The ids a dispatch is routed by. A field of the wrong type is ignored, never a reason to drop the dispatch. */
export const RoutingSchema = z.object({
	id: optional(z.string()),
	type: optional(z.number()),
	guild_id: optional(z.string()),
	channel_id: optional(z.string()),
	user: optional(z.object({ id: z.string() })),
});

type Routing = z.output<typeof RoutingSchema>;

function subjectOf(
	client: Client,
	event: DiscordForwardedDispatch,
	routing: Routing,
): DiscordFilterSubject {
	switch (event) {
		case 'GUILD_CREATE':
		case 'GUILD_DELETE':
			return { type: 'guild', guildId: routing.id };

		case 'GUILD_MEMBER_UPDATE':
		case 'GUILD_ROLE_UPDATE':
		case 'GUILD_ROLE_DELETE':
			return { type: 'guild', guildId: routing.guild_id };

		case 'CHANNEL_CREATE':
		case 'CHANNEL_UPDATE':
		case 'CHANNEL_DELETE':
			return subjectOfRawChannel(routing);

		default:
			return routing.channel_id === undefined
				? { guildId: routing.guild_id }
				: subjectOfChannelId(client, routing.channel_id, routing.guild_id);
	}
}

type DispatchForwarderOptions = {
	client: Client;
	filter: Filter;
	send: (event: DiscordForwardedDispatch, payload: object) => void;
};

/**
 * Turns the gateway's raw packets into dispatch frames: each of the sixteen
 * forwarded dispatches is sent as Discord sent it, under its own name.
 * `GUILD_MEMBER_UPDATE` is forwarded only for the account's own member.
 *
 * The client emits a packet before its own handlers read it, and the frame is
 * encoded right here, so what is forwarded is the payload exactly as received.
 *
 * @param options - The client, the filter rules and where frames go.
 * @returns The handler for the client's `raw` event.
 */
export function createDispatchForwarder({ client, filter, send }: DispatchForwarderOptions) {
	return {
		onPacket(packet: unknown): void {
			const dispatch = DispatchSchema.safeParse(packet);

			if (!dispatch.success) {
				return;
			}

			const { t: event, d: payload } = dispatch.data;
			const routing = RoutingSchema.parse(payload);

			if (event === 'GUILD_MEMBER_UPDATE' && routing.user?.id !== client.user?.id) {
				return;
			}

			if (!isAllowed(filter, { ...subjectOf(client, event, routing), event })) {
				return;
			}

			send(event, payload);
		},
	};
}
