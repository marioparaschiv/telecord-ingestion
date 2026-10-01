import type { TelegramClient } from '@mtcute/node';

import { asError } from '@telecord/producer-core';

type Login = {
	/** The id of the account the session is logged in as. */
	userId: number;
	/** The line telling the user which account that is. */
	line: string;
};

/**
 * Logs the session in. A bot logs in with its token and is never prompted. A
 * user account is prompted for the phone number, login code and 2FA password
 * only when the session holds no valid authorization; mtcute asks again for a
 * code or password Telegram refused.
 *
 * @param client - The session, not yet connected.
 * @param ask - Reads the answer to a prompt.
 * @param botToken - The bot's token, for a bot.
 * @returns The account the session is logged in as.
 * @throws When the login fails, naming the step it failed at.
 */
async function logIn(
	client: TelegramClient,
	ask: (prompt: string) => Promise<string>,
	botToken?: string,
): Promise<Login> {
	let step = botToken === undefined ? 'connection' : 'bot token';
	let prompted = false;

	function prompt(name: string, text: string) {
		return () => {
			step = name;
			prompted = true;

			return ask(text);
		};
	}

	try {
		const me = await client.start(
			botToken === undefined
				? {
						phone: prompt('phone number', 'Phone number (international format): '),
						code: prompt('login code', 'Login code: '),
						password: prompt('2FA password', '2FA password: '),
					}
				: { botToken },
		);
		const account = me.username ? `${me.displayName} (@${me.username})` : me.displayName;

		return {
			userId: me.id,
			line:
				prompted || botToken !== undefined
					? `Logged in as ${account}`
					: `Already logged in as ${account}`,
		};
	} catch (error) {
		throw new Error(`Telegram login failed at the ${step} step: ${asError(error).message}`);
	}
}

export default logIn;
