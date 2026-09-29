import { describe, expect, it } from 'vitest';

import parseOtelEnv from '../src/env';

const enabled = {
	OTEL_ENABLED: 'true',
	OTEL_ENDPOINT: 'http://collector:4318/',
	OTEL_SERVICE_NAME: 'discord-producer',
};

describe('parseOtelEnv', () => {
	it('returns null unless OTEL_ENABLED is true or 1', () => {
		expect(parseOtelEnv({})).toBeNull();
		expect(parseOtelEnv({ ...enabled, OTEL_ENABLED: 'false' })).toBeNull();
		expect(parseOtelEnv({ ...enabled, OTEL_ENABLED: '1' })).not.toBeNull();
	});

	it('throws naming every missing variable when enabled', () => {
		expect(() => parseOtelEnv({ OTEL_ENABLED: 'true' })).toThrow(
			/OTEL_ENDPOINT[\s\S]*OTEL_SERVICE_NAME/,
		);
	});

	it('trims the trailing slash from the endpoint and defaults the lists to empty', () => {
		expect(parseOtelEnv(enabled)).toEqual({
			endpoint: 'http://collector:4318',
			serviceName: 'discord-producer',
			headers: {},
			resourceAttributes: {},
		});
	});

	it('parses url-encoded key=value lists, splitting each pair on its first =', () => {
		const env = parseOtelEnv({
			...enabled,
			OTEL_HEADERS: 'Authorization=Basic%20dXNlcjpwYXNz==, x-team = ingest',
			OTEL_RESOURCE_ATTRIBUTES: 'host.name=box,broken',
		});

		expect(env?.headers).toEqual({
			Authorization: 'Basic dXNlcjpwYXNz==',
			'x-team': 'ingest',
		});
		expect(env?.resourceAttributes).toEqual({ 'host.name': 'box' });
	});

	it('treats a blank list as unset but rejects one with no pairs', () => {
		expect(parseOtelEnv({ ...enabled, OTEL_HEADERS: '  ' })?.headers).toEqual({});
		expect(() => parseOtelEnv({ ...enabled, OTEL_HEADERS: 'no-pairs' })).toThrow(
			/OTEL_HEADERS/,
		);
	});
});
