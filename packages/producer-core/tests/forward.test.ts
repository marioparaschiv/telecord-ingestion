import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { z } from 'zod';

import { createForwardConfigSchema, resolveFilter, type ForwardPlatform } from '../src/forward';
import { createFilterConfigSchema, loadConfig } from '../src/config';
import { isAllowed } from '../src/filter';

const PeerIdSchema = z.string().regex(/^-?\d+$/);

const EntrySchema = z.strictObject({ id: PeerIdSchema, name: z.string().optional() });

const PLATFORM: ForwardPlatform<z.output<typeof EntrySchema>> = {
	entry: EntrySchema,
	fields: ['peerId'],
	targetOf: ({ id }) => ({ field: 'peerId', id }),
	dms: { peerType: ['user'] },
};

const ConfigSchema = z.object({
	filter: createFilterConfigSchema({
		peerType: z.enum(['user', 'group', 'channel']),
		peerId: PeerIdSchema,
	}),
	forward: createForwardConfigSchema(PLATFORM),
});

const CHANNEL = { peerType: 'channel', peerId: '-1001234567890' };
const GROUP = { peerType: 'group', peerId: '-123456789' };
const DM = { peerType: 'user', peerId: '777000123' };

let directory: string;
let files = 0;

function load(toml: string, env: NodeJS.ProcessEnv = {}) {
	const path = join(directory, `config-${++files}.toml`);

	writeFileSync(path, toml);

	return loadConfig(ConfigSchema, { section: 'example', path, env });
}

function filterOf(toml: string, env: NodeJS.ProcessEnv = {}) {
	return resolveFilter(load(toml, env), PLATFORM);
}

beforeAll(() => {
	directory = mkdtempSync(join(tmpdir(), 'producer-forward-'));
});

afterAll(() => {
	rmSync(directory, { recursive: true, force: true });
});

describe('resolveFilter', () => {
	it('denies DMs and allows the rest when nothing is configured', () => {
		expect(filterOf('')).toEqual({
			rules: [{ action: 'deny', match: { peerType: ['user'] } }],
			fallback: 'allow',
		});
	});

	it('runs the configured rules alone without a forward table', () => {
		const filter = filterOf(`
			[[example.filter.rules]]
			action = "deny"
			peerId = "-123456789"
		`);

		expect(filter).toEqual({
			rules: [{ action: 'deny', match: { peerId: ['-123456789'] } }],
			fallback: 'allow',
		});
		expect(isAllowed(filter, DM)).toBe(true);
	});

	it('puts the configured rules before the forward entries and the DM rule', () => {
		const filter = filterOf(`
			[[example.filter.rules]]
			action = "allow"
			peerId = "777000123"

			[example.forward]
			default = "deny"
			allow = [{ id = "-1001234567890", name = "News" }]
		`);

		expect(filter).toEqual({
			rules: [
				{ action: 'allow', match: { peerId: ['777000123'] } },
				{ action: 'allow', match: { peerId: ['-1001234567890'] } },
				{ action: 'deny', match: { peerType: ['user'] } },
			],
			fallback: 'deny',
		});
	});

	it('keeps filter.default as the fallback when forward.default is unset', () => {
		const filter = filterOf(`
			[example.filter]
			default = "deny"

			[example.forward]
			allow = [{ id = "-1001234567890" }]
		`);

		expect(filter.fallback).toBe('deny');
		expect(isAllowed(filter, CHANNEL)).toBe(true);
		expect(isAllowed(filter, GROUP)).toBe(false);
	});

	it('shares DMs when dms is set, unless the configured rules hide them', () => {
		const filter = filterOf(`
			[example.forward]
			dms = true
		`);

		expect(isAllowed(filter, DM)).toBe(true);
		expect(
			isAllowed(
				filterOf(`
					[[example.filter.rules]]
					action = "deny"
					peerType = "user"

					[example.forward]
					dms = true
				`),
				DM,
			),
		).toBe(false);
	});
});

describe('the forward table', () => {
	it('reads the same from the environment as from the file', () => {
		const fromFile = load(`
			[example.forward]
			default = "deny"
			dms = true
			allow = [{ id = "-1001234567890", name = "News" }]
			deny = [{ id = "-123456789" }]
		`);
		const fromEnv = load('', {
			FORWARD_DEFAULT: 'deny',
			FORWARD_DMS: 'true',
			FORWARD_ALLOW: '[{"id":"-1001234567890","name":"News"}]',
			FORWARD_DENY: '[{"id":"-123456789"}]',
		});

		expect(fromFile.forward).toEqual({
			default: 'deny',
			dms: true,
			allow: [{ id: '-1001234567890', name: 'News' }],
			deny: [{ id: '-123456789' }],
		});
		expect(fromEnv.forward).toEqual(fromFile.forward);
	});

	it('reads FORWARD_DMS=false as false', () => {
		expect(load('', { FORWARD_DMS: 'false' }).forward).toEqual({ dms: false });
	});

	it('names the id listed in both allow and deny, and where', () => {
		const toml = `
			[example.forward]
			allow = [{ id = "-1001234567890" }, { id = "-123456789" }]
			deny = [{ id = "777000123" }, { id = "-123456789", name = "Chatter" }]
		`;

		expect(() => load(toml)).toThrow(
			/\n {2}example\.forward\.deny\[1\] \(FORWARD_DENY\): -123456789 is listed in both forward\.allow and forward\.deny$/,
		);
	});

	it('fails loudly on a list in the environment that is not JSON', () => {
		expect(() => load('', { FORWARD_ALLOW: '[{id: 1}]' })).toThrow(
			/example\.forward\.allow \(FORWARD_ALLOW\): Not JSON/,
		);
	});
});
