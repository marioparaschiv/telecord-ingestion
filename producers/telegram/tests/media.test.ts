import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Long, MtTimeoutError, tl } from '@mtcute/node';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';

import { IngestOpcode, type IngestEnvelope } from '@telecord/ingest-client';
import { TelegramOpcode } from '@telecord/ingest-client/telegram';

import { bytesOf, startHarness, vectorUpdates, type Harness } from './fixtures';
import { serialize } from '../src/tl';

const CHANNEL_PEER_ID = '-1001987654321';
const DOCUMENT_ID = Long.fromString('5368324170671202286');
const EXPIRED_REFERENCE = new Uint8Array([1, 1, 1]);
const FRESH_REFERENCE = new Uint8Array([2, 2, 2]);

let harness: Harness;

beforeEach(async () => {
	harness = await startHarness();
	vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(null, { status: 204 }));
});

afterEach(async () => {
	await harness.close();
	vi.restoreAllMocks();
});

function documentLocation(fileReference: Uint8Array): tl.RawInputDocumentFileLocation {
	return {
		_: 'inputDocumentFileLocation',
		id: DOCUMENT_ID,
		accessHash: Long.fromNumber(99),
		fileReference,
		thumbSize: '',
	};
}

async function mediaFetch(
	source: object,
	location: tl.TypeInputFileLocation = documentLocation(EXPIRED_REFERENCE),
): Promise<unknown> {
	harness.socket.send(
		TelegramOpcode.MEDIA_FETCH,
		{
			locator: {
				kind: 'tl',
				location: serialize(location),
				dcId: 4,
			},
			source,
			maxBytes: 1_024,
			upload: { url: 'https://uploads.example.com/bucket', fields: { key: 'object' } },
		},
		'media',
	);

	return (await harness.socket.nextFrame()).d;
}

function expired(): never {
	throw new tl.RpcError(400, 'FILE_REFERENCE_EXPIRED');
}

describe('MEDIA_FETCH', () => {
	it('refreshes an expired file reference through the source message and retries once', async () => {
		const { client } = harness;
		const [update] = vectorUpdates().updates;

		if (update?._ !== 'updateNewChannelMessage' || update.message._ !== 'message') {
			throw new Error('event/update carries no channel message');
		}

		const withDocument: tl.RawMessage = {
			...update.message,
			media: {
				_: 'messageMediaDocument',
				document: {
					_: 'document',
					id: DOCUMENT_ID,
					accessHash: Long.fromNumber(99),
					fileReference: FRESH_REFERENCE,
					date: 0,
					mimeType: 'image/jpeg',
					size: 700,
					dcId: 4,
					attributes: [],
				},
			},
		};

		const download = vi
			.spyOn(client, 'downloadAsIterable')
			.mockImplementationOnce(expired)
			.mockImplementationOnce(() => bytesOf(700));
		const call = vi.spyOn(client, 'call').mockResolvedValue({
			_: 'messages.channelMessages',
			pts: 1,
			count: 1,
			messages: [withDocument],
			topics: [],
			chats: [],
			users: [],
		});

		expect(
			await mediaFetch({
				kind: 'message',
				peerId: CHANNEL_PEER_ID,
				messageId: withDocument.id,
			}),
		).toEqual({ ok: true, bytes: 700 });
		expect(call).toHaveBeenCalledWith(
			expect.objectContaining({
				_: 'channels.getMessages',
				id: [{ _: 'inputMessageID', id: withDocument.id }],
			}),
			expect.anything(),
		);
		expect(download).toHaveBeenLastCalledWith(documentLocation(FRESH_REFERENCE), {
			dcId: 4,
			offset: 0,
			stallTimeout: 40_000,
		});
	});

	it('answers expired for an avatar, which has no message to refresh through', async () => {
		vi.spyOn(harness.client, 'downloadAsIterable').mockImplementation(expired);

		expect(await mediaFetch({ kind: 'avatar' })).toEqual({ ok: false, reason: 'expired' });
	});

	it("uploads a user's photo, which the default DM rule does not filter", async () => {
		vi.spyOn(harness.client, 'downloadAsIterable').mockImplementation(() => bytesOf(700));

		expect(
			await mediaFetch(
				{ kind: 'avatar' },
				{
					_: 'inputPeerPhotoFileLocation',
					big: false,
					peer: { _: 'inputPeerUser', userId: 777000, accessHash: Long.fromNumber(5) },
					photoId: Long.fromNumber(1),
				},
			),
		).toEqual({ ok: true, bytes: 700 });
		expect(fetch).toHaveBeenCalledOnce();
	});

	it('refuses a file larger than maxBytes without uploading it', async () => {
		vi.spyOn(harness.client, 'downloadAsIterable').mockImplementation(() => bytesOf(2_048));

		expect(await mediaFetch({ kind: 'avatar' })).toEqual({
			ok: false,
			message: 'The file is larger than 1024 bytes',
		});
		expect(fetch).not.toHaveBeenCalled();
	});
});

describe('MEDIA_FETCH of a large file', () => {
	/** Telegram's download part size, which a resumed download's offset must be a multiple of. */
	const PART = 65_536;

	/** Every frame answered under the request's nonce, up to and including its result. */
	async function answers(): Promise<IngestEnvelope[]> {
		const received: IngestEnvelope[] = [];

		for (;;) {
			const frame = await harness.socket.nextFrame();

			received.push(frame);

			if (frame.op === TelegramOpcode.MEDIA_FETCH_RESULT) {
				return received;
			}
		}
	}

	function sendMediaFetch(maxBytes: number): void {
		harness.socket.send(
			TelegramOpcode.MEDIA_FETCH,
			{
				locator: {
					kind: 'tl',
					location: serialize(documentLocation(FRESH_REFERENCE)),
					dcId: 4,
				},
				source: { kind: 'avatar' },
				maxBytes,
				upload: { url: 'https://uploads.example.com/bucket', fields: { key: 'object' } },
			},
			'media',
		);
	}

	/** The file the upload posted, read as it is sent, since the producer deletes it afterwards. */
	let uploaded: Uint8Array | undefined;

	beforeEach(() => {
		uploaded = undefined;
		vi.mocked(fetch).mockImplementation(async (_input, init) => {
			const file = init?.body instanceof FormData ? init.body.get('file') : null;

			if (file instanceof Blob) {
				uploaded = new Uint8Array(await file.arrayBuffer());
			}

			return new Response(null, { status: 204 });
		});
	});

	/** A download of `parts` parts, each filled with its index, `delay` apart on the clock. */
	async function* parts(from: number, to: number, delay = 0): AsyncIterableIterator<Uint8Array> {
		for (let index = from; index < to; index++) {
			vi.setSystemTime(Date.now() + delay);

			yield new Uint8Array(PART).fill(index);
		}
	}

	function stall(): never {
		throw new MtTimeoutError(40_000);
	}

	afterEach(() => {
		vi.useRealTimers();
	});

	it('reports progress while a download that outlasts five minutes runs, then uploads it whole', async () => {
		vi.useFakeTimers({ toFake: ['Date'] });
		vi.spyOn(harness.client, 'downloadAsIterable').mockImplementation(() =>
			parts(0, 25, 15_000),
		);

		sendMediaFetch(25 * PART);

		const received = await answers();
		const progress = received.filter(({ op }) => op === IngestOpcode.REQUEST_PROGRESS);

		expect(received.every(({ nonce }) => nonce === 'media')).toBe(true);
		expect(progress.map(({ d }) => d)).toEqual(
			Array.from({ length: 25 }, (_, index) => ({ bytes: (index + 1) * PART })),
		);
		expect(received.at(-1)?.d).toEqual({ ok: true, bytes: 25 * PART });
		expect(uploaded).toHaveLength(25 * PART);
	});

	it('resumes a stalled download from the offset it reached', async () => {
		const download = vi
			.spyOn(harness.client, 'downloadAsIterable')
			.mockImplementationOnce(async function* () {
				yield* parts(0, 2);
				stall();
			})
			.mockImplementationOnce(() => parts(2, 4));

		sendMediaFetch(4 * PART);

		expect((await answers()).at(-1)?.d).toEqual({ ok: true, bytes: 4 * PART });
		expect(download).toHaveBeenLastCalledWith(documentLocation(FRESH_REFERENCE), {
			dcId: 4,
			offset: 2 * PART,
			stallTimeout: 40_000,
		});
		expect([...new Set(uploaded)]).toEqual([0, 1, 2, 3]);
	});

	it('gives up on a download that keeps stalling, having reported no progress', async () => {
		vi.spyOn(harness.client, 'downloadAsIterable').mockImplementation(stall);

		sendMediaFetch(4 * PART);

		const received = await answers();

		expect(received.map(({ op }) => op)).toEqual([TelegramOpcode.MEDIA_FETCH_RESULT]);
		expect(received[0]?.d).toMatchObject({ ok: false });
		expect(fetch).not.toHaveBeenCalled();
	});

	it('writes the download to disk as it arrives, and deletes it once uploaded', async () => {
		const sizes: number[] = [];

		vi.spyOn(harness.client, 'downloadAsIterable').mockImplementation(async function* () {
			for await (const part of parts(0, 3)) {
				const [written] = await Promise.all(
					(await readdir(harness.downloadDir)).map(
						async (name) => (await stat(join(harness.downloadDir, name))).size,
					),
				);

				sizes.push(written ?? -1);

				yield part;
			}
		});

		sendMediaFetch(3 * PART);

		expect((await answers()).at(-1)?.d).toEqual({ ok: true, bytes: 3 * PART });
		expect(sizes).toEqual([0, PART, 2 * PART]);
		expect(await readdir(harness.downloadDir)).toEqual([]);
	});
});
