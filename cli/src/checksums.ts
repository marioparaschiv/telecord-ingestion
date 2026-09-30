import { createHash } from 'node:crypto';

const CHECKSUM_LINE = /^([\da-f]{64}) [ *](.+)$/i;

/**
 * Parses a `sha256sum` listing into the digest of each file it names.
 *
 * @param text - The listing, one `<digest>  <file>` line per file.
 * @returns The lowercase hex digest of each file, by file name.
 * @throws When a line is not a SHA-256 digest followed by a file name.
 */
export function parseChecksums(text: string): Map<string, string> {
	const checksums = new Map<string, string>();

	for (const line of text.split(/\r?\n/)) {
		if (line.trim() === '') {
			continue;
		}

		const match = CHECKSUM_LINE.exec(line);

		if (!match) {
			throw new Error(`Malformed checksum line: ${JSON.stringify(line.slice(0, 200))}`);
		}

		checksums.set(match[2], match[1].toLowerCase());
	}

	return checksums;
}

/**
 * Hashes bytes with SHA-256.
 *
 * @param bytes - The data to hash.
 * @returns The lowercase hex digest.
 */
export function sha256(bytes: Uint8Array): string {
	return createHash('sha256').update(bytes).digest('hex');
}

/**
 * Checks that a file's bytes match the digest its checksums listing gives.
 *
 * @param checksums - The parsed listing.
 * @param file - The file name the listing knows it by.
 * @param bytes - The file's contents.
 * @throws When the listing has no digest for the file, or the digest differs.
 */
export function verifyChecksum(
	checksums: ReadonlyMap<string, string>,
	file: string,
	bytes: Uint8Array,
): void {
	const expected = checksums.get(file);

	if (expected === undefined) {
		throw new Error(`No checksum listed for ${file}`);
	}

	const actual = sha256(bytes);

	if (actual !== expected) {
		throw new Error(`Checksum mismatch for ${file}: expected ${expected}, got ${actual}`);
	}
}
