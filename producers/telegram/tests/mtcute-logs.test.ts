import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { LogManager } from '@mtcute/node/utils.js';
import { NodePlatform } from '@mtcute/node';

import { initLogger } from '@telecord/producer-core';

import bridgeMtcuteLogs from '../src/mtcute-logs';

type DrainedLine = { level: unknown; tag: unknown; message: unknown };

const drained: DrainedLine[] = [];
const manager = new LogManager('base', new NodePlatform());

beforeAll(() => {
	initLogger({
		silent: true,
		drain: ({ event: { level, tag, message } }) => {
			drained.push({ level, tag, message });
		},
	});
	bridgeMtcuteLogs(manager);
});

afterEach(() => {
	drained.length = 0;
});

describe('bridgeMtcuteLogs', () => {
	it('sends mtcute lines to the drain at their level, under the mtcute tag', async () => {
		const network = manager.create('network');

		network.prefix = '[USER 6164918033] ';
		network.warn(
			'Telegram is having internal issues: %d:%s (%s), retrying in %ds',
			-503,
			'Timeout',
			'upload.getFile',
			1,
		);
		manager.create('client').error('Failed to fetch updates: %e', new Error('boom'));

		await vi.waitFor(() => expect(drained).toHaveLength(2));
		expect(drained[0]).toEqual({
			level: 'warn',
			tag: 'mtcute network',
			message:
				'[USER 6164918033] Telegram is having internal issues: -503:Timeout (upload.getFile), retrying in 1s',
		});
		expect(drained[1]).toMatchObject({ level: 'error', tag: 'mtcute client' });
		expect(drained[1]?.message).toMatch(/^Failed to fetch updates: Error: boom\n\s+at /);
	});

	it('keeps mtcute filtering below its level', async () => {
		manager.level = LogManager.WARN;
		manager.create('network').info('Connected to DC %d', 2);
		manager.create('network').warn('Reconnecting');

		await vi.waitFor(() => expect(drained).toHaveLength(1));
		expect(drained[0]).toMatchObject({ level: 'warn', message: 'Reconnecting' });
	});
});
