import { SpanStatusCode, trace, type Attributes, type Span } from '@opentelemetry/api';

import { asError } from '@telecord/producer-core';

const tracer = trace.getTracer('@telecord/producer-otel');

function fail(span: Span, error: unknown): void {
	const exception = asError(error);

	span.recordException(exception);
	span.setStatus({ code: SpanStatusCode.ERROR, message: exception.message });
	span.end();
}

/**
 * Runs `fn` inside an active span. A throw or rejection is recorded on the span with
 * an `ERROR` status and rethrown; the span ends once `fn` returns or settles.
 *
 * @param name - The span name.
 * @param attributes - The attributes the span starts with.
 * @param fn - The work to trace, handed its span.
 * @returns What `fn` returns.
 */
function withSpan<T>(
	name: string,
	attributes: Attributes,
	fn: (span: Span) => Promise<T>,
): Promise<T>;
function withSpan<T>(name: string, attributes: Attributes, fn: (span: Span) => T): T;
function withSpan<T>(
	name: string,
	attributes: Attributes,
	fn: (span: Span) => T | Promise<T>,
): T | Promise<T> {
	return tracer.startActiveSpan(name, { attributes }, (span) => {
		let result: T | Promise<T>;

		try {
			result = fn(span);
		} catch (error) {
			fail(span, error);
			throw error;
		}

		if (!(result instanceof Promise)) {
			span.end();

			return result;
		}

		return result.then(
			(value) => {
				span.end();

				return value;
			},
			(error: unknown) => {
				fail(span, error);
				throw error;
			},
		);
	});
}

export default withSpan;
