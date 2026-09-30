import { readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parseEnv } from 'node:util';

/**
 * Reads a dotenv file, such as the install's `.env`.
 *
 * @param path - The file.
 * @returns Its variables, or undefined when it does not exist.
 */
export async function readEnvFile(path: string): Promise<NodeJS.Dict<string> | undefined> {
	if (!existsSync(path)) {
		return undefined;
	}

	return parseEnv(await readFile(path, 'utf8'));
}

/**
 * Writes a dotenv file readable by its owner only, one `NAME=value` line per
 * variable. Compose reads values unquoted up to the end of the line.
 *
 * @param path - The file.
 * @param variables - Its variables; undefined ones are left out.
 */
export async function writeEnvFile(
	path: string,
	variables: Readonly<Record<string, string | undefined>>,
): Promise<void> {
	const lines = Object.entries(variables).flatMap(([name, value]) =>
		value === undefined ? [] : [`${name}=${value}\n`],
	);

	await writeFile(path, lines.join(''), { mode: 0o600 });
}
