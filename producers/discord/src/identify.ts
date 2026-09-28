import type { Client } from 'discord.js-selfbot-v13';

import type { DiscordIdentifyPayload } from '@telecord/ingest-client/discord';

/**
 * The account as `IDENTIFY` names it, from the client's user, which the
 * gateway keeps current.
 *
 * @param client - The logged-in client.
 * @returns The `IDENTIFY` payload without the stream id.
 * @throws When the client is not logged in.
 */
function identify(client: Client): Omit<DiscordIdentifyPayload, 'streamId'> {
	const { user } = client;

	if (!user) {
		throw new Error('The Discord client is not logged in');
	}

	return {
		id: user.id,
		username: user.username,
		global_name: user.globalName,
		discriminator: user.discriminator,
		avatar: user.avatar,
		bot: user.bot,
	};
}

export default identify;
