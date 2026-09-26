import { afterEach, describe, expect, it, vi } from 'vitest';
import { z } from 'zod';

import {
	DiscordChatsPart,
	DiscordOpcode,
	type DiscordChatsPartPayload,
} from '@telecord/ingest-client/discord';
import { IngestOpcode } from '@telecord/ingest-client';
import type { Filter } from '@telecord/producer-core';

import {
	DM_CHANNEL_ID,
	FRIEND,
	GENERAL_CHANNEL_ID,
	GUILD_ID,
	NOTES_CHANNEL_ID,
	SELF,
	startDiscord,
	vector,
	type DiscordHarness,
} from './fixtures';

const GROUP_DM_CHANNEL_ID = '1100000000000000501';

const ATTACHMENT_URL = `https://cdn.discordapp.com/attachments/${GENERAL_CHANNEL_ID}/1100000000000000300/engine.png?ex=68c9a1b0&is=68c85030&hm=0f1e2d3c`;

let harness: DiscordHarness;

afterEach(async () => {
	await harness.close();
	vi.restoreAllMocks();
});

const GuildMessageSchema = z
	.looseObject({ guild_id: z.string(), member: z.looseObject({}) })
	.transform(({ guild_id: _guildId, member: _member, ...message }) => message);

/** The vectors' guild message, re-addressed to another channel; a DM carries no guild. */
function messageIn(channelId: string, guildId?: string): object {
	const created = vector('event/message-create');
	const message = GuildMessageSchema.parse(created.kind === 'event' ? created.send.d : undefined);

	return guildId === undefined
		? { ...message, channel_id: channelId }
		: { ...message, channel_id: channelId, guild_id: guildId };
}

async function request(op: DiscordOpcode, payload: object): Promise<unknown> {
	harness.socket.send(op, payload, `nonce-${op}`);

	return (await harness.socket.nextFrame()).d;
}

async function snapshot(): Promise<DiscordChatsPartPayload[]> {
	harness.socket.send(DiscordOpcode.CHATS_FETCH, {}, 'snapshot');

	const parts: DiscordChatsPartPayload[] = [];

	for (;;) {
		const part = DiscordChatsPart.parse((await harness.socket.nextFrame()).d);

		parts.push(part);

		if (part.done) {
			return parts;
		}
	}
}

/** The next forwarded dispatch, acknowledged so it leaves the connection's window. */
async function nextDispatch(): Promise<{ op: string; d: unknown }> {
	const { op, d, nonce } = await harness.socket.nextFrame();

	harness.socket.send(IngestOpcode.ACK, null, nonce);

	return { op, d };
}

describe('Discord filter rules', () => {
	it.each([
		['guild', { guildId: [GUILD_ID] }],
		['channel', { channelId: [GENERAL_CHANNEL_ID] }],
	])(
		'drops a denied %s from events, requests and the snapshot without calling Discord',
		async (_kind, match) => {
			const filter: Filter = { rules: [{ action: 'deny', match }], fallback: 'allow' };

			harness = await startDiscord(filter);

			const calls = harness.rest.mock.calls.length;
			const cdn = vi.spyOn(globalThis, 'fetch');
			const denied = messageIn(GENERAL_CHANNEL_ID, GUILD_ID);
			const allowed = messageIn(DM_CHANNEL_ID);

			harness.gateway.dispatch('MESSAGE_CREATE', denied);
			harness.gateway.dispatch('MESSAGE_CREATE', allowed);

			expect(await nextDispatch()).toEqual({ op: 'MESSAGE_CREATE', d: allowed });
			expect(
				await request(DiscordOpcode.MESSAGES_FETCH, {
					channelId: GENERAL_CHANNEL_ID,
					ids: ['1100000000000000100'],
				}),
			).toEqual({ ok: false, reason: 'filtered' });
			expect(
				await request(DiscordOpcode.ATTACHMENT_REFRESH, {
					fileName: 'discord/attachments/1100000000000000300.png',
					url: ATTACHMENT_URL,
				}),
			).toEqual({
				fileName: 'discord/attachments/1100000000000000300.png',
				ok: false,
				reason: 'filtered',
			});

			const parts = await snapshot();
			const channels = parts.flatMap(({ guilds }) =>
				guilds.flatMap((guild) => guild.channels.map(({ id }) => id)),
			);

			expect(channels).not.toContain(GENERAL_CHANNEL_ID);
			expect(parts.flatMap(({ private_channels: dms }) => dms.map(({ id }) => id))).toEqual([
				DM_CHANNEL_ID,
			]);
			expect(harness.rest.mock.calls.length).toBe(calls);
			expect(cdn).not.toHaveBeenCalled();
		},
	);

	it('keeps the guild when only one of its channels is denied', async () => {
		harness = await startDiscord({
			rules: [{ action: 'deny', match: { channelId: [GENERAL_CHANNEL_ID] } }],
			fallback: 'allow',
		});

		const guilds = (await snapshot()).flatMap((part) => part.guilds);

		expect(guilds.map(({ id }) => id)).toEqual([GUILD_ID]);
		expect(guilds.flatMap(({ channels }) => channels.map(({ id }) => id))).toContain(
			NOTES_CHANNEL_ID,
		);
	});

	it('drops DMs and group DMs by default', async () => {
		harness = await startDiscord();

		const calls = harness.rest.mock.calls.length;
		const guildMessage = messageIn(GENERAL_CHANNEL_ID, GUILD_ID);

		harness.gateway.dispatch('MESSAGE_CREATE', messageIn(DM_CHANNEL_ID));
		harness.gateway.dispatch('CHANNEL_CREATE', {
			id: GROUP_DM_CHANNEL_ID,
			type: 3,
			name: 'Engines',
			icon: null,
			recipients: [FRIEND],
		});
		harness.gateway.dispatch('MESSAGE_CREATE', messageIn(GROUP_DM_CHANNEL_ID));
		harness.gateway.dispatch('MESSAGE_CREATE', guildMessage);

		expect(await nextDispatch()).toEqual({ op: 'MESSAGE_CREATE', d: guildMessage });
		expect(
			await request(DiscordOpcode.MESSAGES_FETCH, { channelId: DM_CHANNEL_ID, limit: 50 }),
		).toEqual({ ok: false, reason: 'filtered' });
		expect(
			await request(DiscordOpcode.MESSAGES_FETCH, {
				channelId: GROUP_DM_CHANNEL_ID,
				limit: 50,
			}),
		).toEqual({ ok: false, reason: 'filtered' });

		const parts = await snapshot();

		expect(parts.flatMap(({ private_channels: dms }) => dms)).toEqual([]);
		expect(parts.flatMap(({ guilds }) => guilds.map(({ id }) => id))).toEqual([GUILD_ID]);
		expect(harness.rest.mock.calls.length).toBe(calls);
	});

	it('forwards GUILD_MEMBER_UPDATE for the account alone', async () => {
		harness = await startDiscord();

		const member = {
			guild_id: GUILD_ID,
			roles: [],
			joined_at: '2025-09-16T05:20:00.000000+00:00',
		};
		const own = { ...member, user: SELF, nick: 'Countess' };

		harness.gateway.dispatch('GUILD_MEMBER_UPDATE', {
			...member,
			user: FRIEND,
			nick: 'Babbage',
		});
		harness.gateway.dispatch('GUILD_MEMBER_UPDATE', own);

		expect(await nextDispatch()).toEqual({ op: 'GUILD_MEMBER_UPDATE', d: own });
	});
});
