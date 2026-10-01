import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { User, tl, type TelegramClient } from '@mtcute/node';

import { SELF, createOfflineClient } from './fixtures';
import logIn from '../src/login';

type StartParams = Parameters<TelegramClient['start']>[0];

let client: TelegramClient;

beforeEach(async () => {
	client = await createOfflineClient();
});

afterEach(async () => {
	await client.destroy();
});

/** Stands in for mtcute's login flow: asks each of the given prompts in turn, then signs in or fails. */
function startAsking(
	prompts: readonly ('phone' | 'code' | 'password')[],
	outcome: User | Error = new User(SELF),
) {
	return vi.spyOn(client, 'start').mockImplementation(async (params: StartParams) => {
		for (const name of prompts) {
			const prompt = params?.[name];

			if (typeof prompt === 'function') {
				await prompt();
			}
		}

		if (outcome instanceof Error) {
			throw outcome;
		}

		return outcome;
	});
}

describe('logIn', () => {
	it('prompts for the phone, code and 2FA password and names the account', async () => {
		const ask = vi.fn(async (prompt: string) => `answer to ${prompt}`);

		startAsking(['phone', 'code', 'password']);

		await expect(logIn(client, ask)).resolves.toEqual({
			userId: SELF.id,
			line: 'Logged in as Conformance (@conformance)',
		});
		expect(ask.mock.calls).toEqual([
			['Phone number (international format): '],
			['Login code: '],
			['2FA password: '],
		]);
	});

	it('says a valid saved session is already logged in, without prompting', async () => {
		const ask = vi.fn(async () => '');

		startAsking([]);

		await expect(logIn(client, ask)).resolves.toEqual({
			userId: SELF.id,
			line: 'Already logged in as Conformance (@conformance)',
		});
		expect(ask).not.toHaveBeenCalled();
	});

	it('logs a bot in with its token, without prompting', async () => {
		const ask = vi.fn(async () => '');
		const start = startAsking([]);

		await expect(logIn(client, ask, '4242:token')).resolves.toEqual({
			userId: SELF.id,
			line: 'Logged in as Conformance (@conformance)',
		});
		expect(start).toHaveBeenCalledWith({ botToken: '4242:token' });
		expect(ask).not.toHaveBeenCalled();
	});

	it('names the bot token when Telegram refuses it', async () => {
		startAsking([], new tl.RpcError(400, 'ACCESS_TOKEN_INVALID'));

		await expect(logIn(client, async () => '', '4242:token')).rejects.toThrow(
			/^Telegram login failed at the bot token step: .*ACCESS_TOKEN_INVALID/,
		);
	});

	it('names the step a refused login failed at', async () => {
		startAsking(['phone'], new tl.RpcError(400, 'PHONE_NUMBER_INVALID'));

		await expect(logIn(client, async () => '+0')).rejects.toThrow(
			/^Telegram login failed at the phone number step: .*PHONE_NUMBER_INVALID/,
		);
	});

	it('names the connection when it fails before any prompt', async () => {
		startAsking([], new Error('Connection refused'));

		await expect(logIn(client, async () => '')).rejects.toThrow(
			'Telegram login failed at the connection step: Connection refused',
		);
	});
});
