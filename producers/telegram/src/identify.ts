import type { TelegramClient } from '@mtcute/node';

import { TelegramOpcode, type TelegramIdentifyPayload } from '@telecord/ingest-client/telegram';

/**
 * The account as `IDENTIFY` names it, read fresh from Telegram. Absent fields
 * are left out, since the server refuses `nil` for them.
 *
 * @param client - The logged-in session.
 * @param recovered - Whether the session fetched every update since its stored state.
 * @returns The `IDENTIFY` payload without the stream id.
 */
async function identify(
	client: TelegramClient,
	recovered: boolean,
): Promise<Omit<TelegramIdentifyPayload, 'streamId'>> {
	const { raw: user } = await client.getMe();
	const { accessHash, bot, firstName, lastName, username, usernames, photo } = user;

	return {
		_: 'user',
		id: user.id,
		self: true,
		...(accessHash && { accessHash: accessHash.toString() }),
		...(bot && { bot }),
		...(firstName !== undefined && { firstName }),
		...(lastName !== undefined && { lastName }),
		...(username !== undefined && { username }),
		...(usernames && {
			usernames: usernames.map((entry) => ({
				_: 'username' as const,
				username: entry.username,
			})),
		}),
		...(photo?._ === 'userProfilePhoto' && {
			photo: { _: 'userProfilePhoto', photoId: photo.photoId.toString(), dcId: photo.dcId },
		}),
		requests: [TelegramOpcode.CUSTOM_EMOJIS_FETCH, TelegramOpcode.FORUM_TOPICS_FETCH],
		recovered,
	};
}

export default identify;
