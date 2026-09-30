import { input, password } from '@inquirer/prompts';
import { text } from 'node:stream/consumers';

import { toTomlValue, type Setting } from './settings';
import errorMessage from './error-message';

/**
 * Whether the CLI may ask questions: a terminal on both ends and no `--yes`.
 *
 * @param yes - Whether `--yes` was passed.
 */
export function canPrompt(yes = false): boolean {
	return !yes && process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/**
 * Asks for a setting until the answer is valid, hiding what is typed for a secret.
 *
 * @param setting - The setting.
 * @returns The value to write.
 */
export async function promptSetting(setting: Setting): Promise<unknown> {
	const message = `${setting.key}${setting.meta.description ? ` (${setting.meta.description})` : ''}`;
	const validate = (answer: string) => {
		try {
			toTomlValue(setting, answer);

			return true;
		} catch (error) {
			return errorMessage(error);
		}
	};
	const answer = setting.secret
		? await password({ message, mask: true, validate })
		: await input({ message, default: setting.suggestion, validate });

	return toTomlValue(setting, answer);
}

/**
 * Reads piped stdin, for a value or confirmation given without a terminal.
 *
 * @returns Its text without the trailing newline.
 */
export async function readStdin(): Promise<string> {
	return (await text(process.stdin)).replace(/\r?\n$/, '');
}
