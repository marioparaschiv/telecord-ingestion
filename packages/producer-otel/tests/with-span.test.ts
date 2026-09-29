import {
	InMemorySpanExporter,
	NodeTracerProvider,
	SimpleSpanProcessor,
} from '@opentelemetry/sdk-trace-node';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';

import { SpanStatusCode, trace } from '../src';
import withSpan from '../src/with-span';

const exporter = new InMemorySpanExporter();
const provider = new NodeTracerProvider({ spanProcessors: [new SimpleSpanProcessor(exporter)] });

beforeAll(() => provider.register());
afterEach(() => exporter.reset());
afterAll(() => provider.shutdown());

describe('withSpan', () => {
	it('returns what a synchronous function returns and ends its span', () => {
		expect(withSpan('sync', { 'telecord.platform': 'discord' }, () => 42)).toBe(42);

		const [span] = exporter.getFinishedSpans();

		expect(span?.name).toBe('sync');
		expect(span?.attributes).toEqual({ 'telecord.platform': 'discord' });
		expect(span?.status.code).toBe(SpanStatusCode.UNSET);
	});

	it('keeps the span active until an async function settles', async () => {
		const result = withSpan('async', {}, async (span) => {
			await Promise.resolve();
			expect(trace.getActiveSpan()).toBe(span);
			expect(exporter.getFinishedSpans()).toHaveLength(0);

			return 'done';
		});

		await expect(result).resolves.toBe('done');
		expect(exporter.getFinishedSpans().map((span) => span.name)).toEqual(['async']);
	});

	it('records a throw with an ERROR status, ends the span and rethrows', () => {
		const error = new Error('bad dispatch');

		expect(() =>
			withSpan('throws', {}, () => {
				throw error;
			}),
		).toThrow(error);

		const [span] = exporter.getFinishedSpans();

		expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'bad dispatch' });
		expect(span?.events.map((event) => event.name)).toEqual(['exception']);
	});

	it('records a rejection with an ERROR status, ends the span and rethrows', async () => {
		await expect(
			withSpan('rejects', {}, async () => {
				throw new Error('fetch failed');
			}),
		).rejects.toThrow('fetch failed');

		const [span] = exporter.getFinishedSpans();

		expect(span?.status).toEqual({ code: SpanStatusCode.ERROR, message: 'fetch failed' });
		expect(span?.events.map((event) => event.name)).toEqual(['exception']);
	});
});
