import { randomUUID } from 'node:crypto';
import { WebSocket } from 'ws';

import {
	INGEST_API_KEY_PARAM,
	IngestCloseCode,
	IngestErrorCode,
	IngestErrorSchema,
	IngestHelloSchema,
	IngestOpcode,
	MAX_FRAME_SIZE,
	decodeFrame,
	encodeFrame,
	type IngestEnvelope,
	type IngestFrameOpcode,
} from '@telecord/ingest-client';

import type { RequestHandler } from './requests';

import UnackedBuffer from './unacked-buffer';
import createTaggedLogger from './logger';
import rawDataBytes from './raw-data';
import asError from './as-error';

const MIN_RECONNECT_DELAY = 1_000;
const MAX_RECONNECT_DELAY = 30_000;

/** How long a new socket may take to open and receive `HELLO` before it is abandoned. */
const HANDSHAKE_TIMEOUT = 30_000;

/** Heartbeat intervals without a server `PING` after which the connection is presumed dead. */
const MISSED_PINGS_LIMIT = 2;

/** How long a frame the server could not take yet waits before it is sent again. */
export const RESEND_DELAY = 30_000;

/** Errors after which sending the same frame again fails the same way. */
const UNRECOVERABLE_ERRORS = new Set<string>([
	IngestErrorCode.VALIDATION_ERROR,
	IngestErrorCode.UNKNOWN_OPCODE,
	IngestErrorCode.MISSING_PERMISSION,
]);

/** The one `4001` reason a retry can fix: the server failed while checking the key. */
const TRANSIENT_AUTHENTICATION_REASON = 'Authentication error';

/** The status an unknown route or route version is refused with before the key is read. */
const UNKNOWN_ROUTE_STATUS = 404;

type ConnectionOptions = {
	/** The ingest server's base URL, e.g. `wss://ingest.example.com`. */
	url: string;
	apiKey: string;
	/** The route path, e.g. `/telegram/v1`. */
	route: string;
	/** The query parameter the version is declared under. */
	versionParam: string;
	/** The TL layer or gateway API version every forwarded payload is shaped by. */
	version: number;
	/** How each request opcode is answered. */
	requests: Readonly<Partial<Record<string, RequestHandler>>>;
	/** Called once the server refuses the connection in a way reconnecting cannot fix. */
	onFatal: (reason: string) => void;
};

function isFatalClose(code: number, reason: string): boolean {
	if (code === IngestCloseCode.VERSION_UNSUPPORTED) {
		return true;
	}

	return (
		code === IngestCloseCode.AUTHENTICATION_FAILED && reason !== TRANSIENT_AUTHENTICATION_REASON
	);
}

/**
 * One producer's link to the ingest server, kept alive across drops.
 *
 * Event frames are delivered at least once and in order: each waits in the
 * unacknowledged buffer, and only the oldest is on the wire at a time, because
 * the server handles frames concurrently and an edit sent ahead of its create's
 * `ACK` could be applied first. After a reconnect the buffer is resent from the
 * oldest frame once `HELLO` arrives.
 *
 * Requests are answered as they arrive, through the handler registered for
 * their opcode. A close that only a configuration change or an upgrade fixes
 * stops the connection and calls `onFatal`; anything else reconnects with
 * exponential backoff.
 */
class IngestConnection {
	private logger = createTaggedLogger('Ingest Connection');
	private buffer = new UnackedBuffer();
	private socket: WebSocket | undefined;
	/** Whether the current socket received `HELLO`; event frames wait until it has. */
	private greeted = false;
	private maxFrameSize = MAX_FRAME_SIZE;
	private silenceLimit = HANDSHAKE_TIMEOUT;
	/** The nonce of the event frame awaiting its answer. */
	private inFlight: string | undefined;
	private attempt = 0;
	private stopped = false;
	private silenceTimer: NodeJS.Timeout | undefined;
	private reconnectTimer: NodeJS.Timeout | undefined;
	private resendTimer: NodeJS.Timeout | undefined;

	constructor(private options: ConnectionOptions) {}

	/** How many event frames are waiting for their `ACK`. */
	get unacknowledged(): number {
		return this.buffer.size;
	}

	start(): void {
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;

		clearTimeout(this.silenceTimer);
		clearTimeout(this.reconnectTimer);
		clearTimeout(this.resendTimer);

		this.socket?.close(1000, 'Producer shutting down');
	}

	/**
	 * Queues an event frame under a fresh nonce. It is sent once the connection
	 * is greeted and every older frame is acknowledged.
	 *
	 * @param op - The event opcode.
	 * @param payload - The frame's payload.
	 */
	send(op: IngestFrameOpcode, payload: object): void {
		const nonce = randomUUID();
		const dropped = this.buffer.push(nonce, encodeFrame(op, payload, nonce));

		if (dropped !== undefined) {
			this.logger.warn(
				`Dropped unacknowledged frame ${dropped}: buffer full, ${this.buffer.dropped} lost so far`,
			);
		}

		this.pump();
	}

	private connect(): void {
		const { url: base, route, versionParam, version, apiKey } = this.options;
		const url = new URL(route, base);

		url.searchParams.set(versionParam, String(version));
		url.searchParams.set(INGEST_API_KEY_PARAM, apiKey);

		const socket = new WebSocket(url, { maxPayload: MAX_FRAME_SIZE });
		let refusedStatus: number | undefined;

		this.socket = socket;
		this.greeted = false;
		this.inFlight = undefined;
		this.silenceLimit = HANDSHAKE_TIMEOUT;

		clearTimeout(this.resendTimer);
		this.resendTimer = undefined;
		this.watchSilence(socket);

		socket.on('unexpected-response', (_request, response) => {
			refusedStatus = response.statusCode;
			socket.terminate();
		});

		socket.on('message', (data, isBinary) => {
			if (this.socket === socket && isBinary) {
				this.receive(socket, rawDataBytes(data));
			}
		});

		socket.on('error', (error) => {
			this.logger.warn(`Socket error: ${error.message}`);
		});

		socket.on('close', (code, reason) => {
			if (this.socket === socket) {
				this.disconnected(code, reason.toString(), refusedStatus);
			}
		});
	}

	private receive(socket: WebSocket, data: Uint8Array): void {
		const envelope = decodeFrame(data);

		if (!envelope) {
			this.logger.warn('Discarded a frame that is not a msgpack envelope');

			return;
		}

		switch (envelope.op) {
			case IngestOpcode.HELLO:
				this.greet(socket, envelope.d);

				return;

			case IngestOpcode.PING:
				this.watchSilence(socket);
				socket.send(encodeFrame(IngestOpcode.PONG));

				return;

			case IngestOpcode.ACK:
				this.acknowledge(envelope.nonce);

				return;

			case IngestOpcode.ERROR:
				this.refused(envelope);

				return;
		}

		const handler = this.options.requests[envelope.op];

		if (!handler) {
			this.logger.warn(`Ignoring unexpected opcode ${envelope.op}`);

			return;
		}

		void this.answer(socket, handler, envelope);
	}

	private greet(socket: WebSocket, payload: unknown): void {
		const hello = IngestHelloSchema.safeParse(payload);

		if (!hello.success) {
			this.logger.error(`Malformed HELLO, reconnecting: ${hello.error.message}`);
			socket.terminate();

			return;
		}

		const { heartbeatInterval, versions, maxFrameSize, deprecation } = hello.data;
		const { versionParam, version } = this.options;

		this.greeted = true;
		this.attempt = 0;
		this.maxFrameSize = maxFrameSize;
		this.silenceLimit = heartbeatInterval * MISSED_PINGS_LIMIT;
		this.watchSilence(socket);

		this.logger.info(
			`Connected with ${versionParam} ${version} (window ${versions.min}-${versions.max}), ${this.buffer.size} frames to send`,
		);

		if (deprecation) {
			this.logger.warn(
				`${versionParam} ${version} is deprecated and stays accepted until the window moves past ${deprecation.until}: upgrade before then`,
			);
		}

		if (version > versions.max) {
			this.logger.warn(
				`${versionParam} ${version} is newer than the server supports: events are parked and no snapshot is requested`,
			);
		}

		this.pump();
	}

	private acknowledge(nonce: string | undefined): void {
		if (nonce === undefined) {
			this.logger.warn('Discarded an ACK without a nonce');

			return;
		}

		this.buffer.delete(nonce);
		this.settle(nonce);
	}

	private refused({ d, nonce }: IngestEnvelope): void {
		const error = IngestErrorSchema.safeParse(d);
		const description = error.success
			? `${error.data.code}: ${error.data.message}`
			: 'a malformed ERROR';

		if (nonce === undefined) {
			this.logger.error(`Server answered a frame without a nonce with ${description}`);

			return;
		}

		if (error.success && UNRECOVERABLE_ERRORS.has(error.data.code)) {
			this.logger.warn(`Dropped frame ${nonce}, the server refused it with ${description}`);
			this.buffer.delete(nonce);
		} else if (this.buffer.has(nonce)) {
			this.logger.warn(
				`Server could not take frame ${nonce} yet (${description}), resending in ${RESEND_DELAY}ms`,
			);
			this.scheduleResend();
		}

		this.settle(nonce);
	}

	/** Frees the wire for the next frame once the in-flight one is answered. */
	private settle(nonce: string): void {
		if (nonce !== this.inFlight) {
			return;
		}

		this.inFlight = undefined;
		this.pump();
	}

	private scheduleResend(): void {
		if (this.resendTimer !== undefined) {
			return;
		}

		this.resendTimer = setTimeout(() => {
			this.resendTimer = undefined;
			this.pump();
		}, RESEND_DELAY);
	}

	private pump(): void {
		const socket = this.socket;

		if (!socket || !this.greeted || this.inFlight !== undefined || this.resendTimer) {
			return;
		}

		let next = this.buffer.first();

		while (next && next[1].byteLength > this.maxFrameSize) {
			const [nonce, frame] = next;

			this.logger.error(
				`Dropped frame ${nonce}: ${frame.byteLength} bytes exceeds the ${this.maxFrameSize} byte limit`,
			);
			this.buffer.delete(nonce);
			next = this.buffer.first();
		}

		if (!next) {
			return;
		}

		const [nonce, frame] = next;

		this.inFlight = nonce;
		socket.send(frame);
	}

	private async answer(
		socket: WebSocket,
		handler: RequestHandler,
		{ op, d, nonce }: IngestEnvelope,
	): Promise<void> {
		if (nonce === undefined) {
			this.logger.warn(`Discarded ${op} without a nonce`);

			return;
		}

		try {
			for await (const result of handler.answer(d)) {
				if (!this.write(socket, encodeFrame(handler.result, result, nonce))) {
					this.logger.warn(
						`Stopped answering ${op} ${nonce}: the frame could not be sent`,
					);

					return;
				}
			}
		} catch (error) {
			this.logger.error(`Failed to answer ${op} ${nonce}: ${asError(error).message}`);
		}
	}

	private write(socket: WebSocket, frame: Uint8Array<ArrayBuffer>): boolean {
		if (socket !== this.socket || socket.readyState !== WebSocket.OPEN) {
			return false;
		}

		if (frame.byteLength > this.maxFrameSize) {
			this.logger.error(
				`Frame of ${frame.byteLength} bytes exceeds the ${this.maxFrameSize} byte limit`,
			);

			return false;
		}

		socket.send(frame);

		return true;
	}

	/** Restarts the countdown after which a silent server is presumed gone. */
	private watchSilence(socket: WebSocket): void {
		clearTimeout(this.silenceTimer);

		const limit = this.silenceLimit;

		this.silenceTimer = setTimeout(() => {
			this.logger.warn(`No word from the server in ${limit}ms, reconnecting`);

			// A dead peer never completes the close handshake, so the socket is dropped outright.
			socket.terminate();
		}, limit);
	}

	private disconnected(code: number, reason: string, refusedStatus: number | undefined): void {
		clearTimeout(this.silenceTimer);

		this.socket = undefined;
		this.greeted = false;
		this.inFlight = undefined;

		if (this.stopped) {
			return;
		}

		const description =
			refusedStatus === undefined ? `${code} ${reason}`.trim() : `HTTP ${refusedStatus}`;

		if (refusedStatus === UNKNOWN_ROUTE_STATUS || isFatalClose(code, reason)) {
			this.stopped = true;
			this.logger.error(`Refused by the server (${description}), not reconnecting`);
			this.options.onFatal(description);

			return;
		}

		const delay = Math.min(MIN_RECONNECT_DELAY * 2 ** this.attempt, MAX_RECONNECT_DELAY);

		this.attempt++;
		this.logger.warn(
			`Disconnected (${description}), reconnecting in ${delay}ms with ${this.buffer.size} frames unacknowledged`,
		);
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
	}
}

export default IngestConnection;
