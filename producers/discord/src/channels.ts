import { Constants, type AnyChannel, type Client } from 'discord.js-selfbot-v13';

import type { DiscordFilterSubject } from './filter';

/**
 * The filter subject of a cached channel.
 *
 * @param channel - The channel.
 * @returns Its subject.
 */
export function subjectOfChannel(channel: AnyChannel): DiscordFilterSubject {
	switch (channel.type) {
		case 'DM':
			return { type: 'dm', channelId: channel.id };

		case 'GROUP_DM':
			return { type: 'group_dm', channelId: channel.id };

		default:
			return { type: 'guild', guildId: channel.guildId, channelId: channel.id };
	}
}

/**
 * The filter subject of a channel named by id, read from the gateway cache. A
 * channel outside any guild the cache does not know is taken for a DM, which
 * is what an uncached private channel almost always is.
 *
 * @param client - The client whose cache is read.
 * @param channelId - The channel.
 * @param guildId - The guild, when the payload names it.
 * @returns The subject.
 */
export function subjectOfChannelId(
	client: Client,
	channelId: string,
	guildId?: string,
): DiscordFilterSubject {
	if (guildId !== undefined) {
		return { type: 'guild', guildId, channelId };
	}

	const channel = client.channels.cache.get(channelId);

	return channel ? subjectOfChannel(channel) : { type: 'dm', channelId };
}

/**
 * The filter subject of a raw channel object from a dispatch.
 *
 * @param channel - The channel's id, type and guild.
 * @returns The subject.
 */
export function subjectOfRawChannel(channel: {
	id?: string;
	type?: number;
	guild_id?: string;
}): DiscordFilterSubject {
	switch (channel.type) {
		case Constants.ChannelTypes.DM:
			return { type: 'dm', channelId: channel.id };

		case Constants.ChannelTypes.GROUP_DM:
			return { type: 'group_dm', channelId: channel.id };

		default:
			return { type: 'guild', guildId: channel.guild_id, channelId: channel.id };
	}
}
