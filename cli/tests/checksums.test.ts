import { describe, expect, it } from 'vitest';

import { parseChecksums, sha256, verifyChecksum } from '../src/checksums';

const binary = new TextEncoder().encode('telecord-ingestion binary');
const digest = sha256(binary);

describe('parseChecksums', () => {
	it('reads text and binary mode lines, skipping blanks', () => {
		const checksums = parseChecksums(
			`${digest}  telecord-ingestion-linux-x64\r\n\n${digest.toUpperCase()} *telecord-ingestion-windows-x64.exe\n`,
		);

		expect(checksums).toEqual(
			new Map([
				['telecord-ingestion-linux-x64', digest],
				['telecord-ingestion-windows-x64.exe', digest],
			]),
		);
	});

	it('rejects a line that is not a SHA-256 digest and a file name', () => {
		expect(() => parseChecksums(`${digest.slice(1)}  telecord-ingestion-linux-x64`)).toThrow(
			'Malformed checksum line',
		);
	});
});

describe('verifyChecksum', () => {
	const checksums = parseChecksums(`${digest}  telecord-ingestion-linux-x64\n`);

	it('accepts matching bytes', () => {
		expect(() =>
			verifyChecksum(checksums, 'telecord-ingestion-linux-x64', binary),
		).not.toThrow();
	});

	it('refuses tampered bytes', () => {
		const tampered = new TextEncoder().encode('telecord-ingestion binary!');

		expect(() => verifyChecksum(checksums, 'telecord-ingestion-linux-x64', tampered)).toThrow(
			'Checksum mismatch for telecord-ingestion-linux-x64',
		);
	});

	it('refuses a file the listing does not name', () => {
		expect(() => verifyChecksum(checksums, 'telecord-ingestion-linux-arm64', binary)).toThrow(
			'No checksum listed for telecord-ingestion-linux-arm64',
		);
	});
});
