import {
	InMemorySpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { TelegramOpcode } from '@telecord/ingest-client/telegram';
import type { RequestHandler } from '@telecord/producer-core';

import traceRequest from '../src/trace-request';
import { SpanStatusCode } from '../src';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

function snapshot(parts: object[], failure?: Error): RequestHandler {
	return {
		result: TelegramOpcode.CHATS_FETCH_RESULT,
		async *answer() {
			yield* parts;

			if (failure) {
				throw failure;
			}
		},
	};
}

async function drain(handler: RequestHandler): Promise<object[]> {
	const answered: object[] = [];

	for await (const part of handler.answer({}, () => {})) {
		answered.push(part);
	}

	return answered;
}

beforeAll(() => provider.register());
afterEach(() => exporter.reset());
afterAll(() => provider.shutdown());

describe('traceRequest', () => {
	it('answers as the handler does, in one span counting the parts', async () => {
		const handler = traceRequest(
			'telegram.chats_fetch',
			{ 'telecord.request': 'CHATS_FETCH' },
			snapshot([{ part: 0 }, { part: 1, done: true }]),
		);

		expect(await drain(handler)).toEqual([{ part: 0 }, { part: 1, done: true }]);

		const [span] = exporter.getFinishedSpans();

		expect(span?.name).toBe('telegram.chats_fetch');
		expect(span?.attributes).toEqual({
			'telecord.request': 'CHATS_FETCH',
			'telecord.request.parts': 2,
		});
		expect(span?.status.code).toBe(SpanStatusCode.UNSET);
	});

	it('fails the span and rethrows when the answer throws partway', async () => {
		const handler = traceRequest(
			'discord.chats_fetch',
			{},
			snapshot([{ part: 0 }], new Error('Snapshot needs more than 10000 parts')),
		);

		await expect(drain(handler)).rejects.toThrow('Snapshot needs more than 10000 parts');

		const [span] = exporter.getFinishedSpans();

		expect(span?.attributes['telecord.request.parts']).toBe(1);
		expect(span?.status).toEqual({
			code: SpanStatusCode.ERROR,
			message: 'Snapshot needs more than 10000 parts',
		});
	});

	it('ends the span when the consumer stops early', async () => {
		const handler = traceRequest(
			'telegram.chats_fetch',
			{},
			snapshot([{ part: 0 }, { part: 1 }]),
		);

		for await (const part of handler.answer({}, () => {})) {
			expect(part).toEqual({ part: 0 });

			break;
		}

		expect(exporter.getFinishedSpans()[0]?.attributes['telecord.request.parts']).toBe(1);
	});
});
