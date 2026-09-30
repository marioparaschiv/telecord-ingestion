import { afterEach, describe, expect, it, vi } from 'vitest';
import { render } from 'ink-testing-library';

import type { DiscordForwardEntry } from '@telecord/discord-producer/config';

import { DISCORD_PICKER, TELEGRAM_PICKER, type Chat } from '../src/picker/platforms';
import { forwardOf, stateOf, type PickerState } from '../src/picker/model';
import Picker from '../src/picker/picker';

const DOWN = '\u001B[B';
const TAB = '\t';
const ESCAPE = '\u001B';
const CTRL_C = '\u0003';

const general: Chat = {
	id: '101',
	name: 'general',
	type: 'guild',
	guildId: '100',
	guildName: 'Gaming',
};
const memes: Chat = {
	id: '102',
	name: 'memes',
	type: 'guild',
	guildId: '100',
	guildName: 'Gaming',
};
const bob: Chat = { id: '301', name: 'bob', type: 'dm' };

function flush() {
	return new Promise((resolve) => setImmediate(resolve));
}

function renderDiscord(forward: object = { default: 'deny' }, rules?: object[]) {
	const onDone = vi.fn<(state: PickerState<DiscordForwardEntry> | undefined) => void>();
	const filter = DISCORD_PICKER.filterSchema.parse({ rules });
	const instance = render(
		<Picker
			platform={DISCORD_PICKER}
			chats={[general, memes, bob]}
			initial={stateOf(DISCORD_PICKER.forwardSchema.parse(forward), 'allow', DISCORD_PICKER)}
			filter={filter}
			onDone={onDone}
		/>,
	);

	async function press(...keys: string[]) {
		for (const key of keys) {
			instance.stdin.write(key);
			await flush();
		}
	}

	function saved() {
		const state = onDone.mock.lastCall?.[0];

		return state && forwardOf(state);
	}

	return { ...instance, onDone, press, saved };
}

afterEach(() => {
	vi.useRealTimers();
});

describe('Picker', () => {
	it('shows the current table as ticks and the forwarded count', async () => {
		const { lastFrame, unmount } = renderDiscord({
			default: 'deny',
			allow: [{ guild: '100' }],
			deny: [{ channel: '102' }],
		});

		await flush();

		const frame = lastFrame() ?? '';

		expect(frame).toContain('Discord: 1 of 3 chats forwarded');
		expect(frame).toContain('[-] Gaming (1/2)');
		expect(frame).toContain('[x] general');
		expect(frame).toContain('[ ] memes');
		unmount();
	});

	it('saves a ticked server as one guild entry', async () => {
		const { press, onDone, saved, lastFrame } = renderDiscord();

		await press(' ');

		expect(lastFrame()).toContain('Discord: 2 of 3 chats forwarded');

		await press('s');

		expect(onDone).toHaveBeenCalledOnce();
		expect(saved()).toEqual({
			default: 'deny',
			dms: false,
			allow: [{ guild: '100', name: 'Gaming' }],
		});
	});

	it('searches from the search box, then ticks what it shows', async () => {
		const { press, saved, lastFrame } = renderDiscord();

		await press(TAB, 'b', 'o', 'b');

		expect(lastFrame()).not.toContain('general');

		await press(TAB, DOWN, ' ', 's');

		expect(saved()).toEqual({
			default: 'deny',
			dms: false,
			allow: [{ channel: '301', name: 'bob' }],
		});
	});

	it('clears the search with Escape and toggles the default and DMs', async () => {
		vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

		const { press, saved, lastFrame } = renderDiscord();

		await press(TAB, 'x', 'y', 'z');

		expect(lastFrame()).toContain('No chats match.');

		await press(ESCAPE);
		// Ink holds a lone Escape back to tell it from the start of an escape sequence.
		vi.advanceTimersByTime(20);
		await press(TAB, 'd', 'm');

		expect(lastFrame()).toContain('Unlisted chats: forward (d) · Unlisted DMs: forward (m)');

		await press('s');

		expect(saved()).toEqual({
			default: 'allow',
			dms: true,
		});
	});

	it('warns that hand-written rules go first and flags the chats they override', async () => {
		const { lastFrame, unmount } = renderDiscord({ default: 'allow' }, [
			{ action: 'deny', channelId: '101' },
		]);

		await flush();

		expect(lastFrame()).toContain('config.toml has filter.rules');
		expect(lastFrame()).toContain('[x] general (filter.rules hide it)');
		unmount();
	});

	it('cancels on Ctrl+C, even while searching', async () => {
		const { press, onDone } = renderDiscord();

		await press(TAB, CTRL_C);

		expect(onDone).toHaveBeenCalledExactlyOnceWith(undefined);
	});

	it('renders only the rows that fit', async () => {
		const chats = Array.from({ length: 5000 }, (_, index) => ({
			id: String(-1000 - index),
			name: `Chat ${index}`,
			type: 'channel',
		}));
		const { lastFrame, unmount } = render(
			<Picker
				platform={TELEGRAM_PICKER}
				chats={chats}
				initial={stateOf({}, 'deny', TELEGRAM_PICKER)}
				filter={{ rules: undefined, fallback: 'deny' }}
				onDone={() => {}}
			/>,
		);

		await flush();

		const frame = lastFrame() ?? '';

		expect(frame).toContain('Chat 0');
		expect(frame).not.toContain('Chat 100');
		expect(frame).toContain('1/5001');
		unmount();
	});
});
