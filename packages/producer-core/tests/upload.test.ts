import { afterAll, beforeAll, describe, expect, it } from 'vitest';
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
	let received: Promise<{ type: string | undefined; body: string }>;
	let url: string;
	const server = createServer();

	beforeAll(async () => {
		received = new Promise((resolve) => {
			server.once('request', async (request: IncomingMessage, response) => {
				let body = '';

				for await (const chunk of request) {
					body += String(chunk);
				}

				response.writeHead(204).end();
				resolve({ type: request.headers['content-type'], body });
			});
		});

		await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));

		const address = server.address();

		if (address === null || typeof address === 'string') {
			throw new Error('Upload server is not listening on a TCP port');
		}

		url = `http://127.0.0.1:${address.port}/bucket`;
	});

	afterAll(async () => {
		await new Promise((resolve) => server.close(resolve));
	});

	it('posts the policy fields before the file', async () => {
		const status = await postPresigned(
			{ url, fields: { key: 'objects/1.jpg', policy: 'cG9saWN5' } },
			new TextEncoder().encode('file-bytes'),
		);

		const { type, body } = await received;

		expect(status).toBe(204);
		expect(type).toMatch(/^multipart\/form-data; boundary=/);
		expect(body.indexOf('name="key"')).toBeLessThan(body.indexOf('name="policy"'));
		expect(body.indexOf('name="policy"')).toBeLessThan(body.indexOf('name="file"'));
		expect(body).toContain('file-bytes');
	});
});
