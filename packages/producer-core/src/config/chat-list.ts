import { z } from 'zod';

/**
 * What a producer's `list-chats` mode prints: every chat the account can see,
 * named the way filter rules match it.
 */
const ChatListSchema = z.object({
	platform: z.enum(['telegram', 'discord']),
	chats: z.array(
		z.object({
			/** The `peerId` of a Telegram chat, or the `channelId` of a Discord channel. */
			id: z.string().regex(/^-?\d+$/),
			name: z.string(),
			/** The `peerType` of a Telegram chat, or the `type` of a Discord channel. */
			type: z.string().min(1),
			/** The `guildId` of a Discord guild channel. */
			guildId: z.string().regex(/^\d+$/).optional(),
			guildName: z.string().optional(),
		}),
	),
});

type ChatList = z.output<typeof ChatListSchema>;

export type { ChatList };
export default ChatListSchema;
