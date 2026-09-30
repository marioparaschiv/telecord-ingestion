import type { TelegramClient } from '@mtcute/node';

import { asError } from '@telecord/producer-core';

/**
 * Logs the session in, prompting for the phone number, login code and 2FA
 * password only when it holds no valid authorization. mtcute asks again for a
 * code or password Telegram refused.
 *
 * @param client - The session, not yet connected.
 * @param ask - Reads the answer to a prompt.
 * @returns The line telling the user which account the session is logged in as.
 * @throws When the login fails, naming the step it failed at.
 */
async function logIn(
	client: TelegramClient,
	ask: (prompt: string) => Promise<string>,
): Promise<string> {
	let step = 'connection';
	let prompted = false;

	function prompt(name: string, text: string) {
		return () => {
			step = name;
			prompted = true;

			return ask(text);
		};
	}

	try {
		const me = await client.start({
			phone: prompt('phone number', 'Phone number (international format): '),
			code: prompt('login code', 'Login code: '),
			password: prompt('2FA password', '2FA password: '),
		});
		const account = me.username ? `${me.displayName} (@${me.username})` : me.displayName;

		return prompted ? `Logged in as ${account}` : `Already logged in as ${account}`;
	} catch (error) {
		throw new Error(`Telegram login failed at the ${step} step: ${asError(error).message}`);
	}
}

export default logIn;
