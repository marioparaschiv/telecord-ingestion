import { chmod, readFile, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { parse } from 'smol-toml';

import errorMessage from './error-message';

/**
 * Reads `config.toml`.
 *
 * @param path - The file.
 * @returns Its text, or an empty document when it does not exist.
 */
export async function readConfigFile(path: string): Promise<string> {
	return existsSync(path) ? readFile(path, 'utf8') : '';
}

/**
 * Parses `config.toml` text.
 *
 * @param path - The file, for the error.
 * @param source - Its text.
 * @returns Its tables.
 * @throws When the text is not TOML.
 */
export function parseConfigFile(path: string, source: string): Record<string, unknown> {
	try {
		return parse(source);
	} catch (error) {
		throw new Error(`Failed to read ${path}: ${errorMessage(error)}`);
	}
}

/**
 * Whether a parsed TOML value is a table, telling it from an array and from a
 * date, which smol-toml also parses to an object.
 *
 * @param value - The value.
 */
export function isTable(value: unknown): value is Record<string, unknown> {
	return (
		typeof value === 'object' &&
		value !== null &&
		!Array.isArray(value) &&
		!(value instanceof Date)
	);
}

/**
 * Looks a key path up in parsed `config.toml`.
 *
 * @param table - The parsed file.
 * @param path - The key path, e.g. `['telegram', 'ingest', 'url']`.
 * @returns The value, or undefined when the file does not set it.
 */
export function valueAt(
	table: Readonly<Record<string, unknown>>,
	path: readonly string[],
): unknown {
	return path.reduce<unknown>((value, key) => (isTable(value) ? value[key] : undefined), table);
}

/**
 * Writes `config.toml`, readable by its owner only. The file is truncated and
 * rewritten rather than replaced, since a running container's single-file
 * bind mount pins the inode and would keep seeing a replaced file's old
 * contents.
 *
 * @param path - The file.
 * @param source - Its new text.
 */
export async function writeConfigFile(path: string, source: string): Promise<void> {
	await writeFile(path, source, { mode: 0o600 });
	await chmod(path, 0o600);
}
