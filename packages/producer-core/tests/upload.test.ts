import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { createServer, type IncomingMessage } from 'node:http';

import { postPresigned, readLimited } from '../src/upload';

async function* chunks(...sizes: number[]) {
	for (const size of sizes) {
		yield new Uint8Array(size).fill(size);
	}
}

describe('readLimited', () => {
	it('joins a stream within the limit', async () => {
		expect(await readLimited(chunks(2, 3), 5)).toEqual(new Uint8Array([2, 2, 3, 3, 3]));
	});

	it('gives up on a stream past the limit', async () => {
		expect(await readLimited(chunks(2, 3), 4)).toBeUndefined();
	});
});

describe('postPresigned', () => {
	type Received = { type: string | undefined; body: string };

	const upload = { url: '', fields: { key: 'objects/1.jpg', policy: 'cG9saWN5' } };
	const server = createServer();
	const received: Received[] = [];
	let statuses: number[] = [];

	beforeAll(async () => {
		server.on('request', async (request: IncomingMessage, response) => {
			let body = '';

			for await (const chunk of request) {
				body += String(chunk);
			}

			received.push({ type: request.headers['content-type'], body });
			response.writeHead(statuses.shift() ?? 204).end();
		});

		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

		const address = server.address();

		if (address === null || typeof address === 'string') {
			throw new Error('Upload server is not listening on a TCP port');
		}

		upload.url = `http://127.0.0.1:${address.port}/bucket`;
	});

	beforeEach(() => {
		received.length = 0;
		statuses = [];
	});

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	it('posts the policy fields before the file', async () => {
		const status = await postPresigned(upload, new Blob(['file-bytes']));

		const [{ type, body }] = received;

		expect(status).toBe(204);
		expect(received).toHaveLength(1);
		expect(type).toMatch(/^multipart\/form-data; boundary=/);
		expect(body.indexOf('name="key"')).toBeLessThan(body.indexOf('name="policy"'));
		expect(body.indexOf('name="policy"')).toBeLessThan(body.indexOf('name="file"'));
		expect(body).toContain('file-bytes');
	});

	it('posts the whole file again after a 503 and a 429', async () => {
		statuses = [503, 429];

		const status = await postPresigned(upload, new Blob(['file-bytes']), 0);

		expect(status).toBe(204);
		expect(received).toHaveLength(3);
		expect(received.every(({ body }) => body.includes('file-bytes'))).toBe(true);
	});

	it('returns the last status once a failing store used every attempt', async () => {
		statuses = [503, 500, 503, 500, 503, 204];

		const status = await postPresigned(upload, new Blob(['file-bytes']), 0);

		expect(status).toBe(503);
		expect(received).toHaveLength(5);
	});

	it('does not post again after a rejected policy', async () => {
		statuses = [403];

		const status = await postPresigned(upload, new Blob(['file-bytes']), 0);

		expect(status).toBe(403);
		expect(received).toHaveLength(1);
	});
});
