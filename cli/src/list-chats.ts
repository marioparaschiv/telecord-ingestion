import { ChatListSchema, type ChatList } from '@telecord/producer-core/config';

import type { PlatformName } from './platforms';

import withTelegramStopped from './telegram-session';
import errorMessage from './error-message';
import { compose } from './docker';

function runListChats(dir: string, platform: PlatformName): Promise<string> {
	return compose(dir, ['run', '--rm', '--no-TTY', platform, 'list-chats'], { capture: true });
}

function parseChatList(output: string, platform: PlatformName): ChatList {
	try {
		return ChatListSchema.parse(JSON.parse(output));
	} catch (error) {
		throw new Error(`Failed to list the ${platform} chats: ${errorMessage(error)}`);
	}
}

/**
 * Every chat of a producer's account, from its `list-chats` mode.
 *
 * @param dir - The install directory.
 * @param platform - The producer.
 * @returns The chats.
 * @throws When the listing fails or prints something else.
 */
async function listChats(dir: string, platform: PlatformName): Promise<ChatList> {
	const output =
		platform === 'telegram'
			? await withTelegramStopped(dir, () => runListChats(dir, platform))
			: await runListChats(dir, platform);
	const list = parseChatList(output, platform);

	if (list.platform !== platform) {
		throw new Error(`Failed to list the ${platform} chats: got ${list.platform} chats`);
	}

	return list;
}

export default listChats;
