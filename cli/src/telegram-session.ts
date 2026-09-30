import { compose, composeContainers } from './docker';

function ignoreInterrupt() {}

/**
 * Runs a step that opens Telegram's session with the producer stopped, since
 * both would open the same SQLite session. The producer is started again
 * however the step ends, when it was running before. Ctrl+C reaches the
 * step's docker process, whose exit ends the step, so this process waits it
 * out instead of dying first.
 *
 * @param dir - The install directory.
 * @param step - The step, such as `login` or `list-chats`.
 * @returns What the step returns.
 */
async function withTelegramStopped<T>(dir: string, step: () => Promise<T>): Promise<T> {
	const running = (await composeContainers(dir)).some(
		(container) => container.Service === 'telegram' && container.State === 'running',
	);

	process.on('SIGINT', ignoreInterrupt);

	try {
		if (running) {
			console.log('Stopping Telegram while its session is in use');
			await compose(dir, ['stop', 'telegram']);
		}

		return await step();
	} finally {
		process.off('SIGINT', ignoreInterrupt);

		if (running) {
			await compose(dir, ['start', 'telegram']);
		}
	}
}

export default withTelegramStopped;
