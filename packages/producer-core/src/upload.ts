import { setTimeout as sleep } from 'node:timers/promises';

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

/** The most times one upload is posted. */
const UPLOAD_ATTEMPTS = 5;

/** The wait before the second post, doubled before each one after. */
const UPLOAD_RETRY_DELAY = 500;

const THROTTLED_STATUS = 429;
const SERVER_ERROR_STATUS = 500;

/** Whether the store asked for the same post to be sent again. */
function isRetryableStatus(status: number): boolean {
	return status === THROTTLED_STATUS || status >= SERVER_ERROR_STATUS;
}

async function postOnce(upload: IngestPresignedUpload, file: Blob): Promise<number> {
	const form = new FormData();

	for (const [key, value] of Object.entries(upload.fields)) {
		form.append(key, value);
	}

	form.append('file', file);

	const response = await fetch(upload.url, { method: 'POST', body: form });

	await response.body?.cancel();

	return response.status;
}

/**
 * Posts a file to a presigned upload as multipart form data: every policy field
 * first, then the file, which S3-style policies require to come last. A store
 * that is throttling or failing answers a healthy upload with a 429 or 5xx, so
 * those are posted again.
 *
 * @param upload - The presigned URL and its fields.
 * @param file - The file, which a file-backed blob streams from disk as it is sent.
 * @param retryDelay - The wait before the second post, in milliseconds.
 * @returns The HTTP status the store last answered with.
 */
export async function postPresigned(
	upload: IngestPresignedUpload,
	file: Blob,
	retryDelay = UPLOAD_RETRY_DELAY,
): Promise<number> {
	let status = await postOnce(upload, file);

	for (let attempt = 1; attempt < UPLOAD_ATTEMPTS && isRetryableStatus(status); attempt++) {
		await sleep(retryDelay * 2 ** (attempt - 1));

		status = await postOnce(upload, file);
	}

	return status;
}
