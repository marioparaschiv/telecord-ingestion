import type { z } from 'zod';

import {
	IngestChatsFetchSchema,
	IngestProbeResultSchema,
	IngestProbeSchema,
	type IngestFrameOpcode,
} from '@telecord/ingest-client';

/** The server discards a snapshot answered in more parts than this. */
const CHATS_FETCH_MAX_PARTS = 10_000;

/**
 * Tells the server a request is still being worked on, `bytes` of its file received so far, which
 * keeps it waiting for the answer.
 */
export type ProgressReporter = (bytes: number) => void;

/** How the producer answers one request opcode. */
export type RequestHandler = {
	/** The opcode every answer frame is sent under. */
	result: IngestFrameOpcode;
	/** Yields the payload of each answer frame, in order, reporting progress while it works. */
	answer: (payload: unknown, progress: ProgressReporter) => AsyncIterable<object>;
};

type RequestSpec<PayloadSchema extends z.ZodType, ResultSchema extends z.ZodType<object>> = {
	payload: PayloadSchema;
	result: IngestFrameOpcode;
	resultSchema: ResultSchema;
	/** Must answer every well-formed request, declining with a result rather than throwing. */
	handle: (
		payload: z.output<PayloadSchema>,
		progress: ProgressReporter,
	) => Promise<z.output<ResultSchema>>;
};

/**
 * A request answered with exactly one result. The payload is parsed before the
 * handler sees it, and the result is checked against its schema before it is
 * sent, so a malformed answer is never put on the wire.
 *
 * @param spec - The payload and result schemas, the result opcode and the handler.
 * @returns The handler the connection dispatches the opcode to.
 */
export function defineRequest<
	PayloadSchema extends z.ZodType,
	ResultSchema extends z.ZodType<object>,
>(spec: RequestSpec<PayloadSchema, ResultSchema>): RequestHandler {
	return {
		result: spec.result,
		async *answer(payload, progress) {
			const result = await spec.handle(spec.payload.parse(payload), progress);

			spec.resultSchema.parse(result);

			yield result;
		},
	};
}

/**
 * A `PROBE`, answered by echoing its token without doing any work.
 *
 * @param result - The platform's `PROBE_RESULT` opcode.
 * @returns The handler the connection dispatches `PROBE` to.
 */
export function defineProbe(result: IngestFrameOpcode): RequestHandler {
	return defineRequest({
		payload: IngestProbeSchema,
		result,
		resultSchema: IngestProbeResultSchema,
		handle: async ({ token }) => ({ token }),
	});
}

type SnapshotSpec<Part extends object> = {
	result: IngestFrameOpcode;
	/** The schema of one stamped part, checked before it is sent. */
	partSchema: z.ZodType;
	/** The snapshot's parts in order, without their `part` and `done` stamps. */
	parts: () => AsyncIterable<Part>;
};

/**
 * A `CHATS_FETCH`, answered in parts as the producer yields them: each part is
 * numbered from 0 and the last is marked `done`, so a part is only sent once the
 * next one exists. A producer with nothing to report still answers, with one
 * empty part marked `done`.
 *
 * @param spec - The result opcode, the part schema and the part source.
 * @returns The handler the connection dispatches `CHATS_FETCH` to.
 */
export function defineSnapshot<Part extends object>(spec: SnapshotSpec<Part>): RequestHandler {
	function stamp(fields: object, part: number, done: boolean): object {
		if (part >= CHATS_FETCH_MAX_PARTS) {
			throw new Error(`Snapshot needs more than ${CHATS_FETCH_MAX_PARTS} parts`);
		}

		const stamped = { part, done, ...fields };

		spec.partSchema.parse(stamped);

		return stamped;
	}

	return {
		result: spec.result,
		async *answer(payload) {
			IngestChatsFetchSchema.parse(payload ?? {});

			let part = 0;
			let pending: Part | undefined;

			for await (const next of spec.parts()) {
				if (pending !== undefined) {
					yield stamp(pending, part++, false);
				}

				pending = next;
			}

			yield stamp(pending ?? {}, part, true);
		},
	};
}
