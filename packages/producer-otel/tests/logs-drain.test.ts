import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { NodeTracerProvider } from '@opentelemetry/sdk-trace-node';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { z } from 'zod';

import { createTaggedLogger, initLogger } from '@telecord/producer-core';

import { createLogsDrain, flushLogsDrains } from '../src/logs-drain';
import withSpan from '../src/with-span';

const OtlpLogsSchema = z.object({
	resourceLogs: z.array(
		z.object({
			scopeLogs: z.array(
				z.object({
					logRecords: z.array(
						z.object({
							severityNumber: z.number(),
							severityText: z.string(),
							attributes: z.array(
								z.object({
									key: z.string(),
									value: z.object({ stringValue: z.string() }),
								}),
							),
							traceId: z.string().optional(),
						}),
					),
				}),
			),
		}),
	),
});

type ExportedRecord = {
	severityNumber: number;
	severityText: string;
	attributes: Record<string, string>;
	traceId?: string;
};

const exported: ExportedRecord[] = [];
const tracerProvider = new NodeTracerProvider();
let collector: Server;

function collect(body: string): void {
	for (const { scopeLogs } of OtlpLogsSchema.parse(JSON.parse(body)).resourceLogs) {
		for (const { logRecords } of scopeLogs) {
			for (const { attributes, ...record } of logRecords) {
				exported.push({
					...record,
					attributes: Object.fromEntries(
						attributes.map(({ key, value }) => [key, value.stringValue]),
					),
				});
			}
		}
	}
}

beforeAll(async () => {
	collector = createServer((request, response) => {
		let body = '';

		request.on('data', (chunk: Buffer) => (body += chunk.toString()));
		request.on('end', () => {
			collect(body);
			response.end('{}');
		});
	});

	await new Promise<void>((resolve) => collector.listen(0, '127.0.0.1', resolve));

	const { port } = collector.address() as AddressInfo;

	vi.stubEnv('OTEL_ENABLED', 'true');
	vi.stubEnv('OTEL_ENDPOINT', `http://127.0.0.1:${port}`);
	vi.stubEnv('OTEL_SERVICE_NAME', 'telecord-test-producer');

	tracerProvider.register();
	initLogger({ service: 'telecord-test-producer', silent: true, drain: createLogsDrain() });
});

afterEach(() => {
	exported.length = 0;
});

afterAll(async () => {
	vi.unstubAllEnvs();
	await tracerProvider.shutdown();
	await new Promise<void>((resolve) => collector.close(() => resolve()));
});

describe('createLogsDrain', () => {
	it('is not built while telemetry is off', () => {
		vi.stubEnv('OTEL_ENABLED', 'false');

		expect(createLogsDrain()).toBeUndefined();

		vi.stubEnv('OTEL_ENABLED', 'true');
	});

	it('exports each line with its level, message and tag', async () => {
		const logger = createTaggedLogger('Ingest Connection');

		logger.warn('Socket error: ECONNRESET');
		logger.error('Failed to answer 12 abc: timed out');
		await flushLogsDrains();

		expect(exported).toEqual([
			{
				severityNumber: 13,
				severityText: 'WARN',
				attributes: { tag: 'Ingest Connection', message: 'Socket error: ECONNRESET' },
			},
			{
				severityNumber: 17,
				severityText: 'ERROR',
				attributes: {
					tag: 'Ingest Connection',
					message: 'Failed to answer 12 abc: timed out',
				},
			},
		]);
	});

	it('joins the trace of the span a line is logged in', async () => {
		const logger = createTaggedLogger('Telegram Requests');
		const traceId = withSpan('telegram.users_fetch', {}, (span) => {
			logger.error('Failed to fetch user 42: USER_ID_INVALID');

			return span.spanContext().traceId;
		});

		logger.info('Connected');
		await flushLogsDrains();

		expect(exported.map((record) => record.traceId)).toEqual([traceId, undefined]);
	});
});
