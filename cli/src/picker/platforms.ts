import type { z } from 'zod';

import {
	TELEGRAM_FORWARD,
	TelegramConfigSchema,
	TelegramForwardSchema,
	type TelegramForwardEntry,
} from '@telecord/telegram-producer/config';
import {
	DISCORD_FORWARD,
	DiscordConfigSchema,
	DiscordForwardSchema,
	type DiscordForwardEntry,
} from '@telecord/discord-producer/config';
import type {
	ChatList,
	FilterConfig,
	ForwardConfig,
	ForwardPlatform,
} from '@telecord/producer-core/config';

import type { PlatformName } from '../platforms';

export type Chat = ChatList['chats'][number];

/** A heading of the picker and the chats under it. */
export type ChatGroup = {
	label: string;
	chats: readonly Chat[];
};

/** What the picker knows of a producer: how its chats are grouped, matched and listed. */
export type PickerPlatform<Entry extends object> = {
	name: PlatformName;
	label: string;
	forward: ForwardPlatform<Entry>;
	forwardSchema: z.ZodType<ForwardConfig<Entry>>;
	filterSchema: z.ZodType<FilterConfig>;
	/** What the filter rules see of the chat. */
	subjectOf: (chat: Chat) => Record<string, string>;
	/** The entry listing the chat alone. */
	chatEntry: (chat: Chat) => Entry;
	/** The entry listing a whole server, on platforms that have them. */
	guildEntry?: (guildId: string, name: string) => Entry;
	groups: (chats: readonly Chat[]) => ChatGroup[];
};

const TELEGRAM_GROUPS = [
	{ type: 'channel', label: 'Channels' },
	{ type: 'group', label: 'Groups' },
	{ type: 'user', label: 'DMs' },
];

export const TELEGRAM_PICKER: PickerPlatform<TelegramForwardEntry> = {
	name: 'telegram',
	label: 'Telegram',
	forward: TELEGRAM_FORWARD,
	forwardSchema: TelegramForwardSchema,
	filterSchema: TelegramConfigSchema.shape.filter,
	subjectOf: ({ id, type }) => ({ peerId: id, peerType: type }),
	chatEntry: ({ id, name }) => ({ id, name }),
	groups: (chats) =>
		TELEGRAM_GROUPS.map(({ type, label }) => ({
			label,
			chats: chats.filter((chat) => chat.type === type),
		})).filter((group) => group.chats.length > 0),
};

export const DISCORD_PICKER: PickerPlatform<DiscordForwardEntry> = {
	name: 'discord',
	label: 'Discord',
	forward: DISCORD_FORWARD,
	forwardSchema: DiscordForwardSchema,
	filterSchema: DiscordConfigSchema.shape.filter,
	subjectOf: ({ id, type, guildId }) => ({
		type,
		channelId: id,
		...(guildId !== undefined && { guildId }),
	}),
	chatEntry: ({ id, name, guildId }) => ({
		channel: id,
		name: guildId === undefined ? name : `#${name}`,
	}),
	guildEntry: (guild, name) => ({ guild, name }),
	groups: (chats) => {
		const guilds = Map.groupBy(
			chats.filter((chat) => chat.guildId !== undefined),
			(chat) => chat.guildId,
		);
		const dms = chats.filter((chat) => chat.guildId === undefined);

		return [
			...[...guilds.values()].map((guildChats) => ({
				label: guildChats[0].guildName ?? 'Unnamed server',
				chats: guildChats,
			})),
			...(dms.length > 0 ? [{ label: 'DMs', chats: dms }] : []),
		];
	},
};
