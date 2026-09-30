import { afterEach, describe, expect, it, onTestFinished, vi } from 'vitest';
import { z } from 'zod';

import {
	DISCORD_FORWARDED_DISPATCHES,
	DiscordAttachmentRefreshResult,
	DiscordChatsPart,
	DiscordIdentify,
	DiscordMessagesFetchResult,
	DiscordOpcode,
} from '@telecord/ingest-client/discord';
import {
	IngestMediaFetchResultSchema,
	IngestOpcode,
	IngestProbeResultSchema,
	type IngestEnvelope,
} from '@telecord/ingest-client';
import type { EventVector, RequestVector, VectorFrame } from '@telecord/producer-core/testing';
import { initLogger, type Filter } from '@telecord/producer-core';

import {
	GENERAL_CHANNEL_ID,
	GUILD_ID,
	SELF,
	guildCreate,
	startDiscord,
	vectors,
	type DiscordHarness,
} from './fixtures';

const ALLOW_ALL: Filter = { rules: [], fallback: 'allow' };

const DENY_GENERAL: Filter = {
	rules: [{ action: 'deny', match: { channelId: [GENERAL_CHANNEL_ID] } }],
	fallback: 'allow',
};

const FORWARDED = new Set<string>(DISCORD_FORWARDED_DISPATCHES);

/** A forwarded dispatch no vector sends. */
const SENTINEL = {
	id: '1100000000000000999',
	channel_id: GENERAL_CHANNEL_ID,
	guild_id: GUILD_ID,
};

const RESULT_SCHEMAS = new Map<string, z.ZodType>([
	[DiscordOpcode.PROBE_RESULT, IngestProbeResultSchema],
	[DiscordOpcode.MESSAGES_FETCH_RESULT, DiscordMessagesFetchResult],
	[DiscordOpcode.MEDIA_FETCH_RESULT, IngestMediaFetchResultSchema],
	[DiscordOpcode.ATTACHMENT_REFRESH_RESULT, DiscordAttachmentRefreshResult],
	[DiscordOpcode.CHATS_FETCH_RESULT, DiscordChatsPart],
]);

const events = vectors.vectors.filter(
	(candidate): candidate is EventVector => candidate.kind === 'event',
);
const requests = vectors.vectors.filter(
	(candidate): candidate is RequestVector => candidate.kind === 'request',
);

let harness: DiscordHarness;

afterEach(() => {
	vi.restoreAllMocks();
});

async function start(filter?: Filter): Promise<void> {
	harness = await startDiscord(filter);
	onTestFinished(() => harness.close());
}

function payloadOf(frame: VectorFrame | IngestEnvelope | undefined): object {
	const payload = frame?.d;

	if (typeof payload !== 'object' || payload === null) {
		throw new Error(`${frame?.op} carries no payload`);
	}

	return payload;
}

/** Sends a request and collects its answers: one, or every snapshot part up to the one marked done. */
async function ask(op: DiscordOpcode, payload: unknown, nonce: string): Promise<IngestEnvelope[]> {
	harness.socket.send(op, payload, nonce);

	const answers: IngestEnvelope[] = [];

	for (;;) {
		const frame = await harness.socket.nextFrame();

		answers.push(frame);

		if (op !== DiscordOpcode.CHATS_FETCH || Reflect.get(payloadOf(frame), 'done') === true) {
			return answers;
		}
	}
}

describe('identify', () => {
	it('answers HELLO with the IDENTIFY fields the vectors send, naming the account and its stream', async () => {
		await start();

		const { d } = harness.identify;

		expect(Object.keys(payloadOf(harness.identify)).toSorted()).toEqual(
			Object.keys(payloadOf(vectors.identify)).toSorted(),
		);
		expect(DiscordIdentify.parse(d)).toEqual({
			...SELF,
			bot: false,
			streamId: harness.outbox.streamId,
		});
	});
});

describe('event vectors', () => {
	it('forwards GUILD_CREATE exactly as the gateway sent it, as the first event of the stream', async () => {
		await start();

		expect(harness.backlog).toEqual([{ op: 'GUILD_CREATE', d: guildCreate(), seq: 1 }]);
	});

	it.each(events.map((event) => [event.id, event] as const))(
		'%s: forwards what the gateway sends when it is forwardable, and nothing else',
		async (_id, { send }) => {
			await start(ALLOW_ALL);
			harness.gateway.dispatch(send.op, payloadOf(send));
			// The gateway delivers in order, so the sentinel's frame marks the end of whatever `send` produced.
			harness.gateway.dispatch('MESSAGE_DELETE', SENTINEL);

			const frame = await harness.socket.nextFrame();
			const sentinel = { op: 'MESSAGE_DELETE', d: SENTINEL, seq: expect.any(Number) };

			if (!FORWARDED.has(send.op)) {
				expect(frame).toEqual(sentinel);

				return;
			}

			expect(frame).toEqual({ op: send.op, d: send.d, seq: 2 });
			expect(await harness.socket.nextFrame()).toEqual({ ...sentinel, seq: 3 });
		},
	);

	it.each(events.map((event) => [event.id, event] as const))(
		'%s: keeps a forwarded event until an ACK covers it',
		async (_id, { expect: answer }) => {
			await start();

			const [event] = events;

			harness.gateway.dispatch('MESSAGE_CREATE', payloadOf(event?.send));

			const frame = await harness.socket.nextFrame();
			const acknowledged = answer.op === IngestOpcode.ACK;
			// The vectors answer the stream's first event; here it follows the backlog.
			const seq = 'seq' in payloadOf(answer) ? { seq: frame.seq } : {};

			harness.socket.send(
				z.enum(IngestOpcode).parse(answer.op),
				acknowledged ? seq : { ...payloadOf(answer), ...seq, message: 'from a vector' },
			);
			harness.socket.send(IngestOpcode.PING);

			expect(await harness.socket.nextFrame()).toEqual({ op: IngestOpcode.PONG });
			expect(harness.outbox.size).toBe(acknowledged ? 0 : 1);
		},
	);
});

describe('request vectors', () => {
	function filterFor(id: string): Filter {
		return id.endsWith('-filtered') ? DENY_GENERAL : ALLOW_ALL;
	}

	/** Stubs the Discord and CDN side of an accepted vector. */
	function arrange({ id, request, reply }: RequestVector): void {
		const [first] = reply;

		switch (id) {
			case 'request/messages-fetch-ids':
			case 'request/messages-fetch-range':
				harness.routes.set(`GET /api/v9/channels/${GENERAL_CHANNEL_ID}/messages`, () =>
					Reflect.get(payloadOf(first), 'messages'),
				);

				return;

			case 'request/media-fetch': {
				const size = z.number().parse(Reflect.get(payloadOf(first), 'bytes'));

				vi.spyOn(globalThis, 'fetch').mockImplementation(async (_input, init) =>
					init?.method === 'POST'
						? new Response(null, { status: 204 })
						: new Response(new Uint8Array(size), { status: 200 }),
				);

				return;
			}

			case 'request/attachment-refresh': {
				const url = z.string().parse(Reflect.get(payloadOf(request), 'url'));

				harness.routes.set('POST /api/v9/attachments/refresh-urls', () => ({
					refreshed_urls: [
						{
							original: url.split('?')[0],
							refreshed: Reflect.get(payloadOf(first), 'url'),
						},
					],
				}));

				return;
			}
		}
	}

	it.each(
		requests
			.filter(
				({ outcome, request }) =>
					outcome === 'accepted' && request.op !== DiscordOpcode.CHATS_FETCH,
			)
			.map((request) => [request.id, request] as const),
	)('%s: answers with exactly the vector reply', async (id, request) => {
		await start(filterFor(id));
		arrange(request);

		const nonce = `nonce-${id}`;
		const calls = harness.rest.mock.calls.length;
		const op = z.enum(DiscordOpcode).parse(request.request.op);

		expect(await ask(op, request.request.d, nonce)).toEqual(
			request.reply.map(({ op: replyOp, d }) => ({ op: replyOp, d, nonce })),
		);

		if (filterFor(id) === DENY_GENERAL) {
			expect(harness.rest.mock.calls.length).toBe(calls);
		}
	});

	it('request/chats-fetch: names the same chats, from the gateway cache alone', async () => {
		await start();

		const snapshot = requests.find(({ id }) => id === 'request/chats-fetch');
		const calls = harness.rest.mock.calls.length;
		const cdn = vi.spyOn(globalThis, 'fetch');
		const parts = (await ask(DiscordOpcode.CHATS_FETCH, {}, 'snapshot')).map((part) =>
			DiscordChatsPart.parse(part.d),
		);
		const expected = (snapshot?.reply ?? []).map((part) => DiscordChatsPart.parse(part.d));
		const named = parts.flatMap(({ guilds }) =>
			guilds.flatMap((guild) => [guild.id, ...guild.channels.map(({ id }) => id)]),
		);

		expect(parts.map(({ part, done }) => ({ part, done }))).toEqual(
			parts.map((_part, index) => ({ part: index, done: index === parts.length - 1 })),
		);
		expect(parts.flatMap(({ guilds }) => guilds)).toEqual(
			expected.flatMap(({ guilds }) => guilds),
		);
		expect(named).toEqual(snapshot?.chats);
		expect(harness.rest.mock.calls.length).toBe(calls);
		expect(cdn).not.toHaveBeenCalled();
	});

	describe('a guild whose own member is not cached', () => {
		/** The vector guild announced without members, so the cache holds no member of the account. */
		async function announceMemberless() {
			const snapshot = requests.find(
				({ id }) => id === 'request/chats-fetch-without-self-member',
			);
			const [guild] = (snapshot?.reply ?? []).flatMap(
				(part) => DiscordChatsPart.parse(part.d).guilds,
			);

			if (!guild) {
				throw new Error('request/chats-fetch-without-self-member carries no guild');
			}

			harness.gateway.dispatch('GUILD_CREATE', guild);
			await harness.socket.nextFrame();

			return guild;
		}

		async function snapshotGuild(guildId: string) {
			const parts = (await ask(DiscordOpcode.CHATS_FETCH, {}, 'snapshot')).map((part) =>
				DiscordChatsPart.parse(part.d),
			);

			return parts.flatMap(({ guilds }) => guilds).find(({ id }) => id === guildId);
		}

		it('request/chats-fetch: ships the member fetched over REST', async () => {
			await start();

			const guild = await announceMemberless();

			harness.routes.set(`GET /api/v9/guilds/${guild.id}/members/${SELF.id}`, () => ({
				user: SELF,
				roles: [],
				joined_at: '2025-09-16T05:20:00.000000+00:00',
				deaf: false,
				mute: false,
			}));

			expect(await snapshotGuild(guild.id)).toEqual({ ...guild, self_member: { roles: [] } });
			expect(
				harness.rest.mock.calls.filter(([input]) =>
					String(input).endsWith(`/guilds/${guild.id}/members/${SELF.id}`),
				),
			).toHaveLength(1);
		});

		it('request/chats-fetch-without-self-member: ships the guild without one when the fetch fails, logging the guild', async () => {
			const warnings: unknown[] = [];

			initLogger({
				silent: true,
				drain: ({ event: { level, message } }) => {
					if (level === 'warn') {
						warnings.push(message);
					}
				},
			});
			await start();

			const guild = await announceMemberless();

			expect(await snapshotGuild(guild.id)).toEqual(guild);
			expect(warnings).toContainEqual(
				expect.stringContaining(
					`Failed to fetch the account's member of guild ${guild.id}`,
				),
			);
		});
	});

	it("request/chats-fetch: names each channel's newest message as it arrived", async () => {
		await start();

		const [event] = events.filter(({ send }) => send.op === 'MESSAGE_CREATE');
		const message = payloadOf(event?.send);

		harness.gateway.dispatch('MESSAGE_CREATE', message);
		await harness.socket.nextFrame();

		const parts = (await ask(DiscordOpcode.CHATS_FETCH, {}, 'snapshot')).map((part) =>
			DiscordChatsPart.parse(part.d),
		);
		const general = parts
			.flatMap(({ guilds }) => guilds.flatMap(({ channels }) => channels))
			.find(({ id }) => id === GENERAL_CHANNEL_ID);

		expect(general?.last_message_id).toBe(Reflect.get(message, 'id'));
	});

	it.each(
		requests
			.filter(({ outcome }) => outcome === 'refused')
			.map((request) => [request.id, request] as const),
	)('%s: is a reply the producer never sends', (_id, { reply }) => {
		const [first] = reply;
		const schema = RESULT_SCHEMAS.get(first?.op ?? '');

		if (!schema) {
			throw new Error(`No result schema for ${first?.op}`);
		}

		const malformed = reply.some(({ d }) => !schema.safeParse(d).success);
		// Parts are numbered from 0 by the producer, so a snapshot opening on any other part is never sent.
		const outOfOrder =
			first?.op === DiscordOpcode.CHATS_FETCH_RESULT &&
			Reflect.get(payloadOf(first), 'part') !== 0;

		expect(malformed || outOfOrder).toBe(true);
	});
});
