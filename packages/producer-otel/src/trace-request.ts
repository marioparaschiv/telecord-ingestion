import { context, trace, type Attributes } from '@opentelemetry/api';

import type { RequestHandler } from '@telecord/producer-core';

import recordError from './record-error';

const tracer = trace.getTracer('@telecord/producer-otel');

async function* traceAnswer(
	name: string,
	attributes: Attributes,
	answer: AsyncIterable<object>,
): AsyncGenerator<object> {
	const span = tracer.startSpan(name, { attributes });
	const spanContext = trace.setSpan(context.active(), span);
	const iterator = answer[Symbol.asyncIterator]();
	let parts = 0;
	let finished = false;

	try {
		while (true) {
			// Each step runs in the span's context, so work and logs inside the
			// answer join it; a generator otherwise resumes in its consumer's context.
			const next = await context.with(spanContext, () => iterator.next());

			if (next.done) {
				finished = true;

				return;
			}

			parts++;
			yield next.value;
		}
	} catch (error) {
		finished = true;
		recordError(error, span);
		throw error;
	} finally {
		if (!finished) {
			await iterator.return?.();
		}

		span.setAttribute('telecord.request.parts', parts);
		span.end();
	}
}

/**
 * Wraps a request handler whose answer is streamed in parts in one span that
 * covers the whole answer: it records how many parts were sent and fails when
 * the answer throws.
 *
 * @param name - The span name.
 * @param attributes - The attributes the span starts with.
 * @param handler - The handler to trace.
 * @returns The handler, answering exactly as before.
 */
function traceRequest(
	name: string,
	attributes: Attributes,
	handler: RequestHandler,
): RequestHandler {
	return {
		result: handler.result,
		answer: (payload, progress) =>
			traceAnswer(name, attributes, handler.answer(payload, progress)),
	};
}

export default traceRequest;
