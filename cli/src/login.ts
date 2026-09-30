import { compose } from './docker';

/**
 * Runs Telegram's login mode with the terminal attached, for the phone, code
 * and 2FA prompts. The session it saves lands in the producer's data volume.
 *
 * @param dir - The install directory.
 * @throws When there is no terminal, or the login fails.
 */
async function logInToTelegram(dir: string): Promise<void> {
	if (!process.stdin.isTTY) {
		throw new Error(
			'Failed to log in to Telegram: the login asks for a code, so it needs a terminal',
		);
	}

	try {
		await compose(dir, ['run', '--rm', 'telegram', 'login']);
	} catch (error) {
		throw new Error(
			'Failed to log in to Telegram. Run telecord-ingestion login telegram to retry.',
			{
				cause: error,
			},
		);
	}
}

export default logInToTelegram;
