import { isSpanContextValid, trace } from '@opentelemetry/api';
import type { WideEvent } from 'evlog';

/**
 * Stamps the active span's ids onto an evlog event, making logs joinable with
 * traces.
 *
 * @param ctx - Context whose `event` is mutated in place. Must be called synchronously
 * on the emitting call's async context, while the active span is still current.
 */
function enrichWithTraceContext(ctx: { event: WideEvent }): void {
	// evlog's OTLP drain forwards top-level `traceId`/`spanId` into the LogRecord
	// but never reads OpenTelemetry itself.
	const spanContext = trace.getActiveSpan()?.spanContext();

	// Sampled-out spans still carry valid ids and are stamped.
	if (!spanContext || !isSpanContextValid(spanContext)) {
		return;
	}

	ctx.event.traceId = spanContext.traceId;
	ctx.event.spanId = spanContext.spanId;
}

export default enrichWithTraceContext;
