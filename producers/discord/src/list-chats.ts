import { Constants, type Client } from 'discord.js-selfbot-v13';
import { z } from 'zod';

import type { ChatList } from '@telecord/producer-core/config';

import { subjectOfRawChannel } from './channels';

/** Discord's cap on the guilds one `/users/@me/guilds` page lists. */
const GUILDS_PAGE_LIMIT = 200;

const GuildsSchema = z.array(z.looseObject({ id: z.string(), name: z.string() }));

const ChannelsSchema = z.array(
	z.looseObject({
		id: z.string(),
		type: z.number(),
		name: z.string().nullish(),
		guild_id: z.string().optional(),
		recipients: z
			.array(z.looseObject({ username: z.string(), global_name: z.string().nullish() }))
			.optional(),
	}),
);

type RawChannel = z.output<typeof ChannelsSchema>[number];

type Chat = ChatList['chats'][number];

// discord.js types its REST router as `unknown`; these are the routes listing chats reads through it.
type ChatsRouter = {
	users: (id: '@me') => {
		guilds: { get: (options: { query: Record<string, string> }) => Promise<unknown> };
		channels: { get: () => Promise<unknown> };
	};
	guilds: (id: string) => { channels: { get: () => Promise<unknown> } };
};

// Every read of `client.api` starts a new route: the proxy it returns appends each call to its own path.
function routerOf(client: Client): ChatsRouter {
	return client.api as ChatsRouter;
}

/**
 * Every guild of the account, paged by the last guild's id. A page that lists
 * no guild not already seen ends the walk, so a stuck cursor on an untrusted
 * response cannot loop.
 */
async function readGuilds(client: Client): Promise<z.output<typeof GuildsSchema>> {
	const guilds: z.output<typeof GuildsSchema> = [];
	const seen = new Set<string>();

	while (true) {
		const last = guilds.at(-1);
		const page = GuildsSchema.parse(
			await routerOf(client)
				.users('@me')
				.guilds.get({
					query: { limit: String(GUILDS_PAGE_LIMIT), ...(last && { after: last.id }) },
				}),
		);
		const fresh = page.filter(({ id }) => !seen.has(id));

		for (const guild of fresh) {
			seen.add(guild.id);
			guilds.push(guild);
		}

		if (fresh.length === 0 || page.length < GUILDS_PAGE_LIMIT) {
			return guilds;
		}
	}
}

function nameOf({ name, recipients = [] }: RawChannel): string {
	return name ?? recipients.map((user) => user.global_name ?? user.username).join(', ');
}

function toChat(channel: RawChannel, guild?: { id: string; name: string }): Chat | undefined {
	const { type } = subjectOfRawChannel(channel);

	if (type === undefined) {
		return undefined;
	}

	return {
		id: channel.id,
		name: nameOf(channel),
		type,
		...(guild && { guildId: guild.id, guildName: guild.name }),
	};
}

/**
 * Every chat of the account from Discord's REST API alone, never the gateway:
 * each guild's channels but its categories, then the DMs and group DMs, with
 * the ids filter rules match them by. Requests go through the library's REST
 * client, which carries the producer's client fingerprint and waits out rate limits.
 *
 * Guilds are read one after another, since a burst of requests from a user
 * account draws Discord's attention.
 *
 * @param client - A client holding the account's token, not logged in to the gateway.
 * @returns The chats.
 */
async function listDiscordChats(client: Client): Promise<ChatList> {
	const chats: Chat[] = [];

	for (const guild of await readGuilds(client)) {
		const channels = ChannelsSchema.parse(
			await routerOf(client).guilds(guild.id).channels.get(),
		);

		chats.push(
			...channels
				.filter(({ type }) => type !== Constants.ChannelTypes.GUILD_CATEGORY)
				.flatMap((channel) => toChat(channel, guild) ?? []),
		);
	}

	const privateChannels = ChannelsSchema.parse(
		await routerOf(client).users('@me').channels.get(),
	);

	chats.push(...privateChannels.flatMap((channel) => toChat(channel) ?? []));

	return { platform: 'discord', chats };
}

export default listDiscordChats;
