import { afterEach, describe, expect, it } from 'vitest';

import { DiscordOpcode } from '@telecord/ingest-client/discord';

import {
	GENERAL_CHANNEL_ID,
	GUILD_ID,
	NOTES_CHANNEL_ID,
	SELF,
	startDiscord,
	type DiscordHarness,
} from './fixtures';

const ORIGINAL_ID = '1100000000000000100';
const DELETED_ID = '1100000000000000101';
const NOTE_ID = '1100000000000000102';

let harness: DiscordHarness;

afterEach(async () => {
	await harness.close();
});

function message(id: string, channelId: string, reference?: object) {
	return {
		id,
		type: reference ? 19 : 0,
		channel_id: channelId,
		guild_id: GUILD_ID,
		author: SELF,
		content: `message ${id}`,
		timestamp: '2025-09-16T05:20:00.000000+00:00',
		...(reference && { message_reference: reference }),
	};
}

const ORIGINAL = message(ORIGINAL_ID, GENERAL_CHANNEL_ID);

/** Serves each channel's history: a read around an id answers the page around it, whatever else is there. */
function serveHistory(pages: Record<string, { around: object[]; latest: object[] }>): void {
	for (const [channelId, { around, latest }] of Object.entries(pages)) {
		harness.routes.set(`GET /api/v9/channels/${channelId}/messages`, (url) =>
			url.searchParams.has('around') ? around : latest,
		);
	}
}

function readsOf(channelId: string): URL[] {
	return harness.rest.mock.calls
		.map(([input]) => new URL(input instanceof Request ? input.url : String(input)))
		.filter(({ pathname }) => pathname === `/api/v9/channels/${channelId}/messages`);
}

async function fetchLatest(channelId: string): Promise<unknown> {
	harness.socket.send(DiscordOpcode.MESSAGES_FETCH, { channelId, limit: 50 }, 'fetch');

	return (await harness.socket.nextFrame()).d;
}

describe('MESSAGES_FETCH', () => {
	it('attaches the replied-to message a reply arrived without, and null once it is gone', async () => {
		harness = await startDiscord({ rules: [], fallback: 'allow' });

		const reply = message('1100000000000000110', GENERAL_CHANNEL_ID, {
			type: 0,
			message_id: ORIGINAL_ID,
			channel_id: GENERAL_CHANNEL_ID,
		});
		const orphan = message('1100000000000000111', GENERAL_CHANNEL_ID, {
			type: 0,
			message_id: DELETED_ID,
			channel_id: GENERAL_CHANNEL_ID,
		});

		serveHistory({ [GENERAL_CHANNEL_ID]: { around: [ORIGINAL], latest: [reply, orphan] } });

		expect(await fetchLatest(GENERAL_CHANNEL_ID)).toEqual({
			ok: true,
			messages: [
				{ ...reply, referenced_message: ORIGINAL },
				{ ...orphan, referenced_message: null },
			],
		});
		expect(
			readsOf(GENERAL_CHANNEL_ID)
				.map(({ searchParams }) => searchParams.get('around'))
				.filter(Boolean)
				.toSorted(),
		).toEqual([ORIGINAL_ID, DELETED_ID]);
	});

	it('leaves a reply alone when Discord already sent its reference', async () => {
		harness = await startDiscord({ rules: [], fallback: 'allow' });

		const reply = {
			...message('1100000000000000110', GENERAL_CHANNEL_ID, {
				type: 0,
				message_id: ORIGINAL_ID,
				channel_id: GENERAL_CHANNEL_ID,
			}),
			referenced_message: ORIGINAL,
		};

		serveHistory({ [GENERAL_CHANNEL_ID]: { around: [], latest: [reply] } });

		expect(await fetchLatest(GENERAL_CHANNEL_ID)).toEqual({ ok: true, messages: [reply] });
		expect(readsOf(GENERAL_CHANNEL_ID)).toHaveLength(1);
	});

	it('never reads a reference that sits in a channel the filter rules block', async () => {
		harness = await startDiscord({
			rules: [{ action: 'deny', match: { channelId: [NOTES_CHANNEL_ID] } }],
			fallback: 'allow',
		});

		const crossPost = message('1100000000000000112', GENERAL_CHANNEL_ID, {
			type: 0,
			message_id: NOTE_ID,
			channel_id: NOTES_CHANNEL_ID,
		});

		serveHistory({
			[GENERAL_CHANNEL_ID]: { around: [], latest: [crossPost] },
			[NOTES_CHANNEL_ID]: { around: [message(NOTE_ID, NOTES_CHANNEL_ID)], latest: [] },
		});

		expect(await fetchLatest(GENERAL_CHANNEL_ID)).toEqual({ ok: true, messages: [crossPost] });
		expect(readsOf(NOTES_CHANNEL_ID)).toHaveLength(0);
	});
});
