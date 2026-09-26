import type { IngestPresignedUpload } from '@telecord/ingest-client';

/**
 * Reads a byte stream into one buffer, giving up as soon as it grows past the
 * limit. Leaving the loop early ends the stream, which cancels the download.
 *
 * @param chunks - The stream, e.g. a download or a response body.
 * @param maxBytes - The most bytes accepted.
 * @returns The bytes, or undefined when the stream is larger than `maxBytes`.
 */
export async function readLimited(
	chunks: AsyncIterable<Uint8Array>,
	maxBytes: number,
): Promise<Uint8Array<ArrayBuffer> | undefined> {
	const collected: Uint8Array[] = [];
	let size = 0;

	for await (const chunk of chunks) {
		size += chunk.byteLength;

		if (size > maxBytes) {
			return undefined;
		}

		collected.push(chunk);
	}

	const bytes = new Uint8Array(size);
	let offset = 0;

	for (const chunk of collected) {
		bytes.set(chunk, offset);
		offset += chunk.byteLength;
	}

	return bytes;
}

/**
 * Posts a file to a presigned upload as multipart form data: every policy field
 * first, then the file, which S3-style policies require to come last.
 *
 * @param upload - The presigned URL and its fields.
 * @param bytes - The file.
 * @returns The HTTP status the store answered with.
 */
export async function postPresigned(
	upload: IngestPresignedUpload,
	bytes: Uint8Array<ArrayBuffer>,
): Promise<number> {
	const form = new FormData();

	for (const [key, value] of Object.entries(upload.fields)) {
		form.append(key, value);
	}

	form.append('file', new Blob([bytes]));

	const response = await fetch(upload.url, { method: 'POST', body: form });

	await response.body?.cancel();

	return response.status;
}
