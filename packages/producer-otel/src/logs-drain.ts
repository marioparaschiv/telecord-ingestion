import { createDrainPipeline, type PipelineDrainFn } from 'evlog/pipeline';
import { createOTLPDrain } from 'evlog/otlp';
import type { DrainContext } from 'evlog';

import { asError } from '@telecord/producer-core';

import enrichWithTraceContext from './correlation';
import parseOtelEnv, { type OtelEnv } from './env';

/** Events per OTLP request. */
const BATCH_SIZE = 100;

/** Longest an event waits in the buffer before a flush is forced. */
const FLUSH_INTERVAL = 5_000;

/** Events held before the oldest are dropped. */
const MAX_BUFFER_SIZE = 2_000;

const drains: PipelineDrainFn<DrainContext>[] = [];

function buildDrain(env: OtelEnv): PipelineDrainFn<DrainContext> {
	// No `retry`: evlog's OTLP drain retries internally, then swallows the failure
	// instead of rethrowing, so an outer retry never sees an error. `onDropped`
	// reports buffer overflow only.
	const pipeline = createDrainPipeline<DrainContext>({
		batch: { size: BATCH_SIZE, intervalMs: FLUSH_INTERVAL },
		maxBufferSize: MAX_BUFFER_SIZE,
		onDropped: (events, error) => {
			const message = `[otel] Dropped ${events.length} log event(s)`;

			if (error) {
				console.error(message, asError(error));

				return;
			}

			console.error(message);
		},
	});

	// `headers` is passed even when empty: absent it, evlog sniffs
	// OTEL_EXPORTER_OTLP_HEADERS / OTLP_HEADERS, but auth comes from OTEL_HEADERS alone.
	const otlp = createOTLPDrain({
		endpoint: env.endpoint,
		serviceName: env.serviceName,
		headers: env.headers,
		resourceAttributes: env.resourceAttributes,
	});

	const send = pipeline((batch) => otlp(batch));

	function drain(ctx: DrainContext): void {
		// Must run on the way in, while the emitting call's async context and its
		// active span are still current; by flush time the batch has left it.
		enrichWithTraceContext(ctx);
		send(ctx);
	}

	// `pending` must stay a live accessor onto the wrapped pipeline; copying it
	// as a value would freeze it at its initial count.
	return Object.defineProperties(drain, {
		flush: { value: () => send.flush() },
		pending: { get: () => send.pending },
	}) as PipelineDrainFn<DrainContext>;
}

/**
 * Builds the evlog drain that ships logs over OTLP, batched and bounded, with
 * each event stamped with the active span's ids.
 *
 * @returns The drain, flushed by {@link flushLogsDrains} on shutdown, or `undefined`
 * when `OTEL_ENABLED` is off.
 */
export function createLogsDrain(): PipelineDrainFn<DrainContext> | undefined {
	const env = parseOtelEnv();

	if (!env) {
		return undefined;
	}

	const drain = buildDrain(env);

	drains.push(drain);

	return drain;
}

/**
 * Flushes every drain {@link createLogsDrain} built, so shutdown does not lose
 * buffered logs. Failures are logged, not thrown, so shutdown continues.
 *
 * @returns A promise settling once every drain has flushed or failed to.
 */
export async function flushLogsDrains(): Promise<void> {
	const results = await Promise.allSettled(drains.map((drain) => drain.flush()));

	for (const result of results) {
		if (result.status === 'rejected') {
			console.error('[otel] Failed to flush log drain:', asError(result.reason));
		}
	}
}
