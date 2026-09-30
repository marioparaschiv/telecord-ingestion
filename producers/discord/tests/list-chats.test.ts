import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { Client } from 'discord.js-selfbot-v13';

import { ChatListSchema } from '@telecord/producer-core/config';

import {
	DM_CHANNEL,
	GENERAL_CHANNEL_ID,
	GUILD_ID,
	NOTES_CHANNEL_ID,
	SELF,
	guildCreate,
} from './fixtures';
import listDiscordChats from '../src/list-chats';

const TOKEN = 'test.token.value';
const CATEGORY_ID = '1100000000000000004';
const GROUP_DM_ID = '1100000000000000501';

type RestHandler = (url: URL) => unknown;

let client: Client;
let rest: Mock<typeof fetch>;
let routes: Map<string, RestHandler>;

function guild(index: number) {
	return { id: String(1_200_000_000_000_000_000n + BigInt(index)), name: `Guild ${index}` };
}

function requests(pathname: string): { url: URL; headers: Record<string, string> }[] {
	return rest.mock.calls
		.map(([input, init]) => ({
			url: new URL(input instanceof Request ? input.url : String(input)),
			headers: Object.fromEntries(new Headers(init?.headers).entries()),
		}))
		.filter(({ url }) => url.pathname === pathname);
}

beforeEach(() => {
	client = new Client();
	client.token = TOKEN;
	routes = new Map();
	rest = vi.fn<typeof fetch>(async (input, init) => {
		const url = new URL(input instanceof Request ? input.url : String(input));
		const handler = routes.get(`${init?.method ?? 'GET'} ${url.pathname}`);
		const body = handler ? handler(url) : { message: 'Unknown route', code: 0 };

		return new Response(JSON.stringify(body), {
			status: handler ? 200 : 404,
			headers: { 'content-type': 'application/json' },
		});
	});
	client.rest.fetch = rest;
});

afterEach(() => {
	client.destroy();
});

describe('listDiscordChats', () => {
	it("lists each guild's channels but its categories, then the DMs and group DMs", async () => {
		const { name: guildName, channels } = guildCreate();

		routes.set('GET /api/v9/users/@me/guilds', () => [{ id: GUILD_ID, name: guildName }]);
		routes.set(`GET /api/v9/guilds/${GUILD_ID}/channels`, () => [
			{ id: CATEGORY_ID, type: 4, guild_id: GUILD_ID, name: 'Text Channels' },
			...(Array.isArray(channels) ? channels : []),
		]);
		routes.set('GET /api/v9/users/@me/channels', () => [
			DM_CHANNEL,
			{
				id: GROUP_DM_ID,
				type: 3,
				name: null,
				recipients: [SELF, { ...SELF, global_name: null }],
			},
		]);

		const list = await listDiscordChats(client);

		expect(ChatListSchema.parse(list)).toEqual(list);
		expect(list).toEqual({
			platform: 'discord',
			chats: [
				{
					id: GENERAL_CHANNEL_ID,
					name: expect.any(String),
					type: 'guild',
					guildId: GUILD_ID,
					guildName,
				},
				{
					id: NOTES_CHANNEL_ID,
					name: expect.any(String),
					type: 'guild',
					guildId: GUILD_ID,
					guildName,
				},
				{ id: DM_CHANNEL.id, name: 'Charles', type: 'dm' },
				{ id: GROUP_DM_ID, name: 'Ada, ada', type: 'group_dm' },
			],
		});
	});

	it('pages through every guild and stops on a page with nothing new', async () => {
		const guilds = Array.from({ length: 201 }, (_, index) => guild(index));

		routes.set('GET /api/v9/users/@me/guilds', (url) => {
			const after = url.searchParams.get('after');

			// Ignores the cursor past the first page, as a misbehaving server might.
			return after === null
				? guilds.slice(0, 200)
				: guilds.slice(200).concat(guilds.slice(0, 199));
		});

		for (const { id } of guilds) {
			routes.set(`GET /api/v9/guilds/${id}/channels`, () => [
				{ id: String(BigInt(id) + 1n), type: 0, guild_id: id, name: 'general' },
			]);
		}

		routes.set('GET /api/v9/users/@me/channels', () => []);

		const { chats } = await listDiscordChats(client);
		const pages = requests('/api/v9/users/@me/guilds');

		expect(chats).toHaveLength(201);
		expect(pages.map(({ url }) => url.searchParams.get('after'))).toEqual([
			null,
			guilds[199]?.id,
			guilds[200]?.id,
		]);
		expect(pages.every(({ url }) => url.searchParams.get('limit') === '200')).toBe(true);
	});

	it("reads through the library's REST client, with its token and fingerprint", async () => {
		routes.set('GET /api/v9/users/@me/guilds', () => []);
		routes.set('GET /api/v9/users/@me/channels', () => []);

		await listDiscordChats(client);

		const [request] = requests('/api/v9/users/@me/guilds');

		expect(request?.headers).toMatchObject({
			authorization: TOKEN,
			'user-agent': client.options.http?.headers?.['User-Agent'],
			'x-super-properties': Buffer.from(
				JSON.stringify(client.options.ws?.properties),
			).toString('base64'),
		});
	});

	it('fails when Discord refuses a route', async () => {
		await expect(listDiscordChats(client)).rejects.toThrow('Unknown route');
	});
});
