import {
	Constants,
	type Client,
	type Guild,
	type GuildMember,
	type NonThreadGuildBasedChannel,
	type PermissionOverwrites,
	type Role,
	type User,
} from 'discord.js-selfbot-v13';

import {
	asError,
	createTaggedLogger,
	defineSnapshot,
	isAllowed,
	type Filter,
	type RequestHandler,
} from '@telecord/producer-core';
import { DiscordChatsPart, DiscordOpcode } from '@telecord/ingest-client/discord';
import { CHATS_PART_MAX_CHATS } from '@telecord/ingest-client';
import { traceRequest } from '@telecord/producer-otel';

import { subjectOfChannel } from './channels';

const logger = createTaggedLogger('Discord Snapshot');

const ROLE_OVERWRITE = 0;
const MEMBER_OVERWRITE = 1;

type DiscordChatsPartFields = {
	guilds: object[];
	private_channels: object[];
};

function rawUser(user: User) {
	return {
		id: user.id,
		username: user.username,
		discriminator: user.discriminator,
		global_name: user.globalName,
		avatar: user.avatar,
		bot: user.bot,
	};
}

function rawRole(role: Role) {
	return {
		id: role.id,
		name: role.name,
		color: role.color,
		permissions: role.permissions.bitfield.toString(),
		position: role.rawPosition,
		hoist: role.hoist,
		managed: role.managed,
		mentionable: role.mentionable,
	};
}

function rawOverwrite(overwrite: PermissionOverwrites) {
	return {
		id: overwrite.id,
		type: overwrite.type === 'role' ? ROLE_OVERWRITE : MEMBER_OVERWRITE,
		allow: overwrite.allow.bitfield.toString(),
		deny: overwrite.deny.bitfield.toString(),
	};
}

/**
 * The channel's newest message id, which the client keeps current as messages
 * arrive, left out for a channel that holds no messages.
 */
function lastMessageOf(channel: object): { last_message_id?: string } {
	return 'lastMessageId' in channel && typeof channel.lastMessageId === 'string'
		? { last_message_id: channel.lastMessageId }
		: {};
}

function rawChannel(channel: NonThreadGuildBasedChannel) {
	return {
		id: channel.id,
		type: Constants.ChannelTypes[channel.type],
		guild_id: channel.guildId,
		name: channel.name,
		position: channel.rawPosition,
		parent_id: channel.parentId,
		permission_overwrites: channel.permissionOverwrites.cache.map(rawOverwrite),
		...lastMessageOf(channel),
	};
}

function rawSelfMember(member: GuildMember) {
	return {
		user: rawUser(member.user),
		roles: member.roles.cache
			.filter((role) => role.id !== member.guild.id)
			.map((role) => role.id),
		nick: member.nickname,
		joined_at: member.joinedAt?.toISOString() ?? null,
	};
}

/**
 * The account's own member of a guild: the cached one, or else fetched over REST. A failed fetch is
 * logged and answers undefined, so the guild ships without it.
 */
async function selfMemberOf(guild: Guild): Promise<GuildMember | undefined> {
	const userId = guild.client.user?.id;

	if (!userId) {
		return undefined;
	}

	// Not `members.me`: with member partials enabled it invents an empty member when none is cached.
	const cached = guild.members.cache.get(userId);

	if (cached) {
		return cached;
	}

	try {
		return await guild.members.fetchMe();
	} catch (error) {
		logger.warn(
			`Failed to fetch the account's member of guild ${guild.id}: ${asError(error).message}`,
		);

		return undefined;
	}
}

/** A cached guild as a raw guild object, holding only the channels the filter rules allow. */
async function rawGuild(guild: Guild, filter: Filter) {
	const channels = guild.channels.cache
		.filter((channel): channel is NonThreadGuildBasedChannel => !channel.isThread())
		.filter((channel) => isAllowed(filter, subjectOfChannel(channel)))
		.map(rawChannel);
	const self = await selfMemberOf(guild);

	return {
		id: guild.id,
		name: guild.name,
		icon: guild.icon,
		owner_id: guild.ownerId,
		roles: guild.roles.cache.map(rawRole),
		channels,
		...(self && { self_member: rawSelfMember(self) }),
	};
}

function rawPrivateChannels(client: Client, filter: Filter): object[] {
	const channels: object[] = [];

	for (const channel of client.channels.cache.values()) {
		if (!isAllowed(filter, subjectOfChannel(channel))) {
			continue;
		}

		if (channel.type === 'DM' && !channel.partial) {
			channels.push({
				id: channel.id,
				type: Constants.ChannelTypes.DM,
				recipients: [rawUser(channel.recipient)],
				...lastMessageOf(channel),
			});
		} else if (channel.type === 'GROUP_DM') {
			channels.push({
				id: channel.id,
				type: Constants.ChannelTypes.GROUP_DM,
				name: channel.name,
				icon: channel.icon,
				recipients: channel.recipients.map(rawUser),
				...lastMessageOf(channel),
			});
		}
	}

	return channels;
}

/**
 * The account's chats as snapshot parts, read from the gateway cache: one part
 * per guild, then the DMs and group DMs. Only the account's own member of a
 * guild whose member is not cached is fetched.
 */
async function* snapshotParts(
	client: Client,
	filter: Filter,
): AsyncGenerator<DiscordChatsPartFields> {
	for (const guild of client.guilds.cache.values()) {
		if (isAllowed(filter, { type: 'guild', guildId: guild.id })) {
			yield { guilds: [await rawGuild(guild, filter)], private_channels: [] };
		}
	}

	const privateChannels = rawPrivateChannels(client, filter);

	for (let start = 0; start < privateChannels.length; start += CHATS_PART_MAX_CHATS) {
		yield {
			guilds: [],
			private_channels: privateChannels.slice(start, start + CHATS_PART_MAX_CHATS),
		};
	}
}

/**
 * The `CHATS_FETCH` handler of a Discord producer.
 *
 * @param client - The ready client whose cache is read.
 * @param filter - The producer's filter rules.
 * @returns The handler.
 */
export function createDiscordSnapshot(client: Client, filter: Filter): RequestHandler {
	return traceRequest(
		'discord.chats_fetch',
		{ 'telecord.platform': 'discord', 'telecord.request': 'CHATS_FETCH' },
		defineSnapshot({
			result: DiscordOpcode.CHATS_FETCH_RESULT,
			partSchema: DiscordChatsPart,
			parts: () => snapshotParts(client, filter),
		}),
	);
}
