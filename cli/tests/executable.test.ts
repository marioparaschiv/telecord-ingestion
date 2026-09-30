import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { afterAll, describe, expect, it } from 'vitest';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
	installedExecutable,
	removeReplacedExecutable,
	replaceExecutable,
} from '../src/executable';

const directory = await mkdtemp(join(tmpdir(), 'telecord-ingestion-'));

afterAll(async () => {
	await rm(directory, { recursive: true, force: true });
});

describe('installedExecutable', () => {
	it('accepts an installed binary', () => {
		expect(installedExecutable('/home/me/.local/bin/telecord-ingestion')).toBe(
			'/home/me/.local/bin/telecord-ingestion',
		);
	});

	it('rejects bun running from source', () => {
		expect(installedExecutable('/home/me/.bun/bin/bun')).toBeUndefined();
	});
});

describe('replaceExecutable', () => {
	it('swaps the file in place', async () => {
		const path = join(directory, 'telecord-ingestion');

		await writeFile(path, 'v1');
		await replaceExecutable(path, new TextEncoder().encode('v2'), 'linux');

		expect(await readFile(path, 'utf8')).toBe('v2');
		expect(existsSync(`${path}.new`)).toBe(false);
		expect(existsSync(`${path}.old`)).toBe(false);
	});

	it('moves the old exe aside on Windows until the next run removes it', async () => {
		const path = join(directory, 'telecord-ingestion.exe');

		await writeFile(path, 'v1');
		await replaceExecutable(path, new TextEncoder().encode('v2'), 'win32');

		expect(await readFile(path, 'utf8')).toBe('v2');
		expect(await readFile(`${path}.old`, 'utf8')).toBe('v1');

		await removeReplacedExecutable(path);

		expect(existsSync(`${path}.old`)).toBe(false);
	});
});
