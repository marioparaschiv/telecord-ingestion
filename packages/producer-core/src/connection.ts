import { WebSocket } from 'ws';

import {
	INGEST_API_KEY_PARAM,
	IngestAckSchema,
	IngestCloseCode,
	IngestErrorSchema,
	IngestHelloSchema,
	IngestOpcode,
	IngestReadySchema,
	MAX_FRAME_SIZE,
	decodeFrame,
	encodeFrame,
	type IngestEnvelope,
	type IngestFrameOpcode,
} from '@telecord/ingest-client';

import type { RequestHandler } from './requests';
import type Outbox from './outbox';

import createTaggedLogger from './logger';
import rawDataBytes from './raw-data';
import asError from './as-error';

const MIN_RECONNECT_DELAY = 1_000;
const MAX_RECONNECT_DELAY = 30_000;

/** How long a new socket may take to open and receive `HELLO` before it is abandoned. */
const HANDSHAKE_TIMEOUT = 30_000;

/** Heartbeat intervals without a server `PING` after which the connection is presumed dead. */
const MISSED_PINGS_LIMIT = 2;

/** The `4001` reasons a retry can fix: the server failed while checking the key or storing the user. */
const TRANSIENT_AUTHENTICATION_REASONS = new Set(['Authentication error', 'Identification error']);

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
	/** The stream every forwarded event is stored in and read back from. */
	outbox: Outbox;
	/** The most events sent and not yet acknowledged. */
	window: number;
	/** The account the producer is logged in as, as `IDENTIFY` names it without the stream id. */
	identify: () => Promise<object>;
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
		code === IngestCloseCode.AUTHENTICATION_FAILED &&
		!TRANSIENT_AUTHENTICATION_REASONS.has(reason)
	);
}

/**
 * One producer's link to the ingest server, kept alive across drops.
 *
 * Forwarded events are stored in the outbox under their `seq` and streamed
 * from it: nothing is sent before the server answers `IDENTIFY` with `READY`,
 * every `READY` (the answer to `IDENTIFY`, or a rewind after a gap) restarts
 * the stream at `lastSeq + 1`, at most `window` events are unacknowledged at a
 * time, and a cumulative `ACK` deletes every event it covers. Request results
 * are not events: they are sent live and never stored.
 *
 * Requests are answered as they arrive, through the handler registered for
 * their opcode. A close that only a configuration change or an upgrade fixes,
 * or another producer taking over the stream, stops the connection and calls
 * `onFatal`; anything else reconnects with exponential backoff.
 */
class IngestConnection {
	private logger = createTaggedLogger('Ingest Connection');
	private socket: WebSocket | undefined;
	/** Whether the current socket received `READY`; events wait until it has. */
	private ready = false;
	/** The highest `seq` the server has stored. */
	private acknowledged = 0;
	/** The highest `seq` sent on the current stream. */
	private sent = 0;
	private maxFrameSize = MAX_FRAME_SIZE;
	private silenceLimit = HANDSHAKE_TIMEOUT;
	private attempt = 0;
	private stopped = false;
	private silenceTimer: NodeJS.Timeout | undefined;
	private reconnectTimer: NodeJS.Timeout | undefined;

	constructor(private options: ConnectionOptions) {}

	start(): void {
		this.stopped = false;
		this.connect();
	}

	stop(): void {
		this.stopped = true;
		this.ready = false;

		clearTimeout(this.silenceTimer);
		clearTimeout(this.reconnectTimer);

		this.socket?.close(1000, 'Producer shutting down');
	}

	/**
	 * Stores an event under the next `seq` and sends it once the stream reaches it.
	 *
	 * @param op - The event opcode.
	 * @param payload - The frame's payload.
	 * @param capture - The outbox capture the event was built from, released with it.
	 */
	send(op: IngestFrameOpcode, payload: object, capture?: number): void {
		const seq = this.options.outbox.append((next) => {
			const frame = encodeFrame(op, payload, undefined, next);

			if (frame.byteLength <= this.maxFrameSize) {
				return frame;
			}

			this.logger.error(
				`Dropped ${op}: ${frame.byteLength} bytes exceeds the ${this.maxFrameSize} byte limit`,
			);

			return undefined;
		}, capture);

		if (seq !== undefined) {
			this.pump();
		}
	}

	private connect(): void {
		const { url: base, route, versionParam, version, apiKey } = this.options;
		const url = new URL(route, base);

		url.searchParams.set(versionParam, String(version));
		url.searchParams.set(INGEST_API_KEY_PARAM, apiKey);

		const socket = new WebSocket(url, { maxPayload: MAX_FRAME_SIZE });
		let refusedStatus: number | undefined;

		this.socket = socket;
		this.ready = false;
		this.silenceLimit = HANDSHAKE_TIMEOUT;

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

			case IngestOpcode.READY:
				this.resume(socket, envelope.d);

				return;

			case IngestOpcode.PING:
				this.watchSilence(socket);
				socket.send(encodeFrame(IngestOpcode.PONG));

				return;

			case IngestOpcode.ACK:
				this.acknowledge(envelope.d);

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

		this.attempt = 0;
		this.maxFrameSize = maxFrameSize;
		this.silenceLimit = heartbeatInterval * MISSED_PINGS_LIMIT;
		this.watchSilence(socket);

		this.logger.info(
			`Connected with ${versionParam} ${version} (window ${versions.min}-${versions.max})`,
		);

		if (deprecation) {
			this.logger.warn(
				`${versionParam} ${version} is deprecated and stays accepted until the window moves past ${deprecation.until}: upgrade before then`,
			);
		}

		if (version > versions.max) {
			this.logger.warn(
				`${versionParam} ${version} is newer than the server supports: events are held and no snapshot is requested`,
			);
		}

		void this.identify(socket);
	}

	private async identify(socket: WebSocket): Promise<void> {
		const { identify, outbox } = this.options;

		try {
			const identity = await identify();

			this.write(
				socket,
				encodeFrame(IngestOpcode.IDENTIFY, { ...identity, streamId: outbox.streamId }),
			);
		} catch (error) {
			this.logger.error(`Failed to identify, reconnecting: ${asError(error).message}`);
			socket.terminate();
		}
	}

	/** Restarts the stream after `lastSeq`, whether `READY` answers `IDENTIFY` or rewinds past a gap. */
	private resume(socket: WebSocket, payload: unknown): void {
		const ready = IngestReadySchema.safeParse(payload);

		if (!ready.success) {
			this.logger.error(`Malformed READY, reconnecting: ${ready.error.message}`);
			socket.terminate();

			return;
		}

		const { lastSeq } = ready.data;
		const { outbox } = this.options;

		outbox.acknowledge(lastSeq);
		outbox.fastForward(lastSeq);

		const [first] = outbox.after(lastSeq, 1);

		if (first && first.seq > lastSeq + 1) {
			this.logger.error(
				`The outbox no longer holds events ${lastSeq + 1}-${first.seq - 1} of stream ${outbox.streamId}: streaming from ${first.seq}`,
			);
		}

		this.logger.info(
			`${this.ready ? 'Rewinding' : 'Streaming'} from ${lastSeq + 1}, ${outbox.size} events to send`,
		);

		this.ready = true;
		this.acknowledged = lastSeq;
		this.sent = lastSeq;
		this.pump();
	}

	private acknowledge(payload: unknown): void {
		const ack = IngestAckSchema.safeParse(payload);

		if (!ack.success) {
			this.logger.warn(`Discarded a malformed ACK: ${ack.error.message}`);

			return;
		}

		const { seq } = ack.data;

		if (seq <= this.acknowledged) {
			return;
		}

		this.options.outbox.acknowledge(seq);
		this.acknowledged = seq;
		this.sent = Math.max(this.sent, seq);
		this.pump();
	}

	/** An event the server refused still counts as consumed; the `ACK` that follows deletes it. */
	private refused({ d }: IngestEnvelope): void {
		const error = IngestErrorSchema.safeParse(d);

		if (!error.success) {
			this.logger.error('Server answered with a malformed ERROR');

			return;
		}

		const { code, message, seq } = error.data;

		this.logger.warn(
			seq === undefined
				? `Server answered with ${code}: ${message}`
				: `Server refused event ${seq} with ${code}: ${message}`,
		);
	}

	/**
	 * Sends the events after the last one sent, up to the window. The window is
	 * counted from the last acknowledged `seq`, so a stream that starts past a gap
	 * the server skips sends the same number of events.
	 */
	private pump(): void {
		const socket = this.socket;

		if (!socket || !this.ready) {
			return;
		}

		const room = this.acknowledged + this.options.window - this.sent;

		if (room <= 0) {
			return;
		}

		for (const { seq, frame } of this.options.outbox.after(this.sent, room)) {
			socket.send(frame);
			this.sent = seq;
		}
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
		this.ready = false;

		if (this.stopped) {
			return;
		}

		const description =
			refusedStatus === undefined ? `${code} ${reason}`.trim() : `HTTP ${refusedStatus}`;

		if (code === IngestCloseCode.SUPERSEDED) {
			this.stopped = true;
			this.logger.error(
				`Another producer identified on stream ${this.options.outbox.streamId} and took it over: two producers share this outbox, stopping this one`,
			);
			this.options.onFatal(description);

			return;
		}

		if (refusedStatus === UNKNOWN_ROUTE_STATUS || isFatalClose(code, reason)) {
			this.stopped = true;
			this.logger.error(`Refused by the server (${description}), not reconnecting`);
			this.options.onFatal(description);

			return;
		}

		const delay = Math.min(MIN_RECONNECT_DELAY * 2 ** this.attempt, MAX_RECONNECT_DELAY);

		this.attempt++;
		this.logger.warn(
			`Disconnected (${description}), reconnecting in ${delay}ms with ${this.options.outbox.size} events unacknowledged`,
		);
		this.reconnectTimer = setTimeout(() => this.connect(), delay);
	}
}

export default IngestConnection;
