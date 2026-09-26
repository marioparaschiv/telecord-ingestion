import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';

import { AsyncQueue } from '@telecord/producer-core/testing';

const HELLO = 10;
const HEARTBEAT = 1;
const HEARTBEAT_ACK = 11;
const IDENTIFY = 2;
const DISPATCH = 0;

const GatewayFrameSchema = z.object({ op: z.number(), d: z.unknown().optional() });

/** One client connection to the fake gateway. */
class GatewaySession {
	private sequence = 0;
	/** Settles once the client identified. */
	readonly identified: Promise<void>;

	constructor(private socket: WebSocket) {
		this.identified = new Promise((resolve) => {
			socket.on('message', (data) => {
				const frame = GatewayFrameSchema.parse(JSON.parse(String(data)));

				if (frame.op === IDENTIFY) {
					resolve();
				} else if (frame.op === HEARTBEAT) {
					this.send({ op: HEARTBEAT_ACK });
				}
			});
		});

		this.send({ op: HELLO, d: { heartbeat_interval: 45_000 } });
	}

	/** Sends one op-0 dispatch, the way Discord does, as JSON text. */
	dispatch(event: string, payload: object): void {
		this.send({ op: DISPATCH, t: event, s: ++this.sequence, d: payload });
	}

	private send(frame: object): void {
		this.socket.send(JSON.stringify(frame));
	}
}

/**
 * A local Discord gateway speaking just enough of the protocol for a client to
 * log in: `HELLO`, then dispatches the test sends once the client identified.
 */
export class FakeDiscordGateway {
	private sessions = new AsyncQueue<GatewaySession>();

	private constructor(private wss: WebSocketServer) {
		wss.on('connection', (socket) => this.sessions.push(new GatewaySession(socket)));
	}

	/**
	 * Starts a gateway on a free local port.
	 *
	 * @returns The listening gateway.
	 */
	static async start(): Promise<FakeDiscordGateway> {
		const wss = new WebSocketServer({ host: '127.0.0.1', port: 0 });

		await new Promise((resolve) => wss.once('listening', resolve));

		return new FakeDiscordGateway(wss);
	}

	get url(): string {
		const address = this.wss.address();

		if (address === null || typeof address === 'string') {
			throw new Error('Fake gateway is not listening on a TCP port');
		}

		return `ws://127.0.0.1:${address.port}`;
	}

	/**
	 * The next client session, once it identified.
	 *
	 * @returns The session.
	 */
	async nextSession(): Promise<GatewaySession> {
		const session = await this.sessions.next();

		await session.identified;

		return session;
	}

	async close(): Promise<void> {
		for (const socket of this.wss.clients) {
			socket.terminate();
		}

		await new Promise((resolve) => this.wss.close(resolve));
	}
}

export type { GatewaySession };
