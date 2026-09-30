import { rename, rm, writeFile } from 'node:fs/promises';
import { basename } from 'node:path';

/**
 * Finds the installed binary this process runs from.
 *
 * @param path - The running executable.
 * @returns The path, or undefined when running from source, where the executable is bun itself.
 */
export function installedExecutable(path = process.execPath): string | undefined {
	return basename(path).startsWith('telecord-ingestion') ? path : undefined;
}

/**
 * Replaces an executable with new contents. Windows locks a running exe
 * against writes but not renames, so there the old one is moved aside to
 * `<path>.old` for {@link removeReplacedExecutable} to delete on a later run.
 *
 * @param path - The executable to replace.
 * @param bytes - Its new contents.
 * @param platform - The operating system it runs on.
 */
export async function replaceExecutable(
	path: string,
	bytes: Uint8Array,
	platform: NodeJS.Platform = process.platform,
): Promise<void> {
	const staged = `${path}.new`;

	await writeFile(staged, bytes, { mode: 0o755 });

	if (platform !== 'win32') {
		await rename(staged, path);

		return;
	}

	const old = `${path}.old`;

	await rm(old, { force: true });
	await rename(path, old);

	try {
		await rename(staged, path);
	} catch (error) {
		await rename(old, path);

		throw error;
	}
}

/**
 * Deletes the executable {@link replaceExecutable} moved aside on Windows.
 * Another instance still running the old one keeps it locked, in which case
 * it stays for the next run.
 *
 * @param path - The executable that was replaced.
 */
export async function removeReplacedExecutable(path: string): Promise<void> {
	try {
		await rm(`${path}.old`, { force: true });
	} catch (error) {
		const code = error instanceof Error && 'code' in error ? error.code : undefined;

		if (code !== 'EBUSY' && code !== 'EPERM') {
			throw error;
		}
	}
}
