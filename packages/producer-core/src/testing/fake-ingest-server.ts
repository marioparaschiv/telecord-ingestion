import { createServer, type Server } from 'node:http';
import { WebSocketServer, type WebSocket } from 'ws';

import {
	IngestOpcode,
	MAX_FRAME_SIZE,
	decodeFrame,
	encodeFrame,
	type IngestEnvelope,
	type IngestFrameOpcode,
	type IngestHello,
} from '@telecord/ingest-client';

import rawDataBytes from '../raw-data';
import AsyncQueue from './async-queue';

/** One producer connection as the fake server sees it. */
export class FakeProducerSocket {
	private frames = new AsyncQueue<IngestEnvelope>();
	/** Settles once the producer's socket is closed, with the code it closed with. */
	readonly closed: Promise<number>;

	constructor(
		/** The URL the producer connected with. */
		readonly url: URL,
		private socket: WebSocket,
	) {
		this.closed = new Promise((resolve) => socket.once('close', resolve));

		socket.on('message', (data, isBinary) => {
			const envelope = isBinary ? decodeFrame(rawDataBytes(data)) : undefined;

			if (envelope) {
				this.frames.push(envelope);
			}
		});
	}

	send(op: IngestFrameOpcode, payload?: unknown, nonce?: string): void {
		this.socket.send(encodeFrame(op, payload, nonce));
	}

	/** Greets the producer the way the server does, with a heartbeat of 30 seconds by default. */
	hello(overrides: Partial<IngestHello> = {}): void {
		this.send(IngestOpcode.HELLO, {
			heartbeatInterval: 30_000,
			versions: { min: 1, max: 1_000 },
			maxFrameSize: MAX_FRAME_SIZE,
			...overrides,
		});
	}

	/**
	 * The next frame the producer sent.
	 *
	 * @returns The decoded frame.
	 */
	nextFrame(): Promise<IngestEnvelope> {
		return this.frames.next();
	}

	/** Frames received and not yet taken with `nextFrame`. */
	get pendingFrames(): readonly IngestEnvelope[] {
		return this.frames.pending;
	}

	close(code: number, reason: string): void {
		this.socket.close(code, reason);
	}

	/** Drops the connection without a close handshake, as a dead peer would. */
	terminate(): void {
		this.socket.terminate();
	}
}

/**
 * A local ingest server for producer tests: it records every connection and
 * leaves the protocol to the test, which greets, requests and answers through
 * each {@link FakeProducerSocket}.
 */
export class FakeIngestServer {
	private connections = new AsyncQueue<FakeProducerSocket>();
	private sockets = new Set<WebSocket>();
	/** When set, upgrades are refused over HTTP with this status instead of accepted. */
	refuseWith: number | undefined;

	private constructor(
		private http: Server,
		private wss: WebSocketServer,
	) {
		wss.on('connection', (socket, request) => {
			this.sockets.add(socket);
			socket.once('close', () => this.sockets.delete(socket));
			this.connections.push(
				new FakeProducerSocket(new URL(request.url ?? '/', this.url), socket),
			);
		});

		http.on('upgrade', (request, stream, head) => {
			if (this.refuseWith !== undefined) {
				stream.end(`HTTP/1.1 ${this.refuseWith} Refused\r\nConnection: close\r\n\r\n`);

				return;
			}

			wss.handleUpgrade(request, stream, head, (socket) => {
				wss.emit('connection', socket, request);
			});
		});
	}

	/**
	 * Starts a server on a free local port.
	 *
	 * @returns The listening server.
	 */
	static async start(): Promise<FakeIngestServer> {
		const http = createServer();
		const wss = new WebSocketServer({ noServer: true, maxPayload: MAX_FRAME_SIZE });

		await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));

		return new FakeIngestServer(http, wss);
	}

	get url(): string {
		const address = this.http.address();

		if (address === null || typeof address === 'string') {
			throw new Error('Fake ingest server is not listening on a TCP port');
		}

		return `ws://127.0.0.1:${address.port}`;
	}

	/**
	 * The next producer connection.
	 *
	 * @returns The connection, once the producer opened it.
	 */
	nextConnection(): Promise<FakeProducerSocket> {
		return this.connections.next();
	}

	/** Connections opened and not yet taken with `nextConnection`. */
	get pendingConnections(): readonly FakeProducerSocket[] {
		return this.connections.pending;
	}

	async close(): Promise<void> {
		for (const socket of this.sockets) {
			socket.terminate();
		}

		await new Promise<void>((resolve, reject) => {
			this.wss.close();
			this.http.close((error) => (error ? reject(error) : resolve()));
		});
	}
}
