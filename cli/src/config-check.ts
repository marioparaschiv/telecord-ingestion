import { loadConfig } from '@telecord/producer-core/config';

import type { ComposeModel } from './docker';
import type { Platform } from './platforms';

import errorMessage from './error-message';

/**
 * The environment compose gives a producer's container, from
 * `compose.override.yml` or the variables it passes through.
 *
 * @param model - The install's compose model.
 * @param platform - The producer.
 * @returns Its variables that have a value.
 */
export function serviceEnvironment(
	model: ComposeModel,
	platform: Platform,
): Record<string, string> {
	const environment = model.services[platform.name]?.environment ?? {};

	return Object.fromEntries(
		Object.entries(environment).filter((entry): entry is [string, string] => entry[1] !== null),
	);
}

/**
 * Checks a producer's settings the way it reads them when it starts.
 *
 * @param path - The install's `config.toml`.
 * @param platform - The producer.
 * @param env - Its container's environment.
 * @returns What is missing or invalid, or undefined when the producer can start.
 */
export function configProblem(
	path: string,
	platform: Platform,
	env: Readonly<Record<string, string>>,
): string | undefined {
	try {
		loadConfig(platform.schema, { section: platform.name, path, env });

		return undefined;
	} catch (error) {
		return errorMessage(error);
	}
}
