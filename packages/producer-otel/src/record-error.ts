import { SpanStatusCode, trace, type Span } from '@opentelemetry/api';

import { asError } from '@telecord/producer-core';

/**
 * Records an error on a span and marks the span failed, for an error that is
 * handled rather than thrown out of the span.
 *
 * @param error - Whatever was caught.
 * @param span - The span to mark, the active one unless given.
 */
function recordError(error: unknown, span: Span | undefined = trace.getActiveSpan()): void {
	if (!span) {
		return;
	}

	const exception = asError(error);

	span.recordException(exception);
	span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
}

export default recordError;
