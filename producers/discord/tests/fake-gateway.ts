import { WebSocketServer, type WebSocket } from 'ws';
import { z } from 'zod';

import { AsyncQueue } from '@telecord/producer-core/testing';

const DISPATCH = 0;
const HEARTBEAT = 1;
const IDENTIFY = 2;
const RESUME = 6;
const INVALID_SESSION = 9;
const HELLO = 10;
const HEARTBEAT_ACK = 11;

const GatewayFrameSchema = z.object({ op: z.number(), d: z.unknown().optional() });

const ResumeSchema = z.object({ token: z.string(), session_id: z.string(), seq: z.number() });

export type ResumeRequest = z.infer<typeof ResumeSchema>;

/** How the gateway answers a `RESUME`: the dispatches it replays then `RESUMED`, or an invalid session. */
export type ResumeAnswer =
	| { outcome: 'resumed'; dispatches: { event: string; payload: object }[] }
	| { outcome: 'invalid' };

type SessionHooks = {
	/** Names the session a client identifies. */
	nextSessionId: () => string;
	answerResume: (request: ResumeRequest) => ResumeAnswer;
};

/** One client connection to the fake gateway. */
class GatewaySession {
	private sequence = 0;
	/** The session the client identified or resumed. */
	id = '';
	/** Whether the client resumed a session rather than identifying. */
	resumed = false;
	/** Settles once the client identified, or resumed a session the gateway accepted. */
	readonly established: Promise<void>;
	/** Settles with the code the connection closed with. */
	readonly closed: Promise<number>;

	constructor(
		private socket: WebSocket,
		hooks: SessionHooks,
	) {
		this.closed = new Promise((resolve) => socket.on('close', resolve));
		this.established = new Promise((resolve) => {
			socket.on('message', (data) => {
				const frame = GatewayFrameSchema.parse(JSON.parse(String(data)));

				switch (frame.op) {
					case IDENTIFY:
						this.id = hooks.nextSessionId();
						this.sequence = 0;
						resolve();

						return;

					case RESUME: {
						const request = ResumeSchema.parse(frame.d);

						if (this.resume(request, hooks.answerResume(request))) {
							resolve();
						}

						return;
					}

					case HEARTBEAT:
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

	/** Closes the connection from the gateway's side, as Discord does with a close code. */
	close(code: number, reason: string): void {
		this.socket.close(code, reason);
	}

	/** @returns Whether the session resumed. */
	private resume(request: ResumeRequest, answer: ResumeAnswer): boolean {
		if (answer.outcome === 'invalid') {
			this.send({ op: INVALID_SESSION, d: false });

			return false;
		}

		this.id = request.session_id;
		this.resumed = true;
		this.sequence = request.seq;

		for (const { event, payload } of answer.dispatches) {
			this.dispatch(event, payload);
		}

		this.dispatch('RESUMED', {});

		return true;
	}

	private send(frame: object): void {
		this.socket.send(JSON.stringify(frame));
	}
}

/**
 * A local Discord gateway speaking just enough of the protocol for a client to
 * log in: `HELLO`, then dispatches the test sends once the client identified.
 * A `RESUME` is recorded and answered as `answerResume` says.
 */
export class FakeDiscordGateway {
	private sessions = new AsyncQueue<GatewaySession>();
	/** How many times a client identified. */
	identified = 0;
	/** Every `RESUME` received, in order. */
	readonly resumes: ResumeRequest[] = [];
	answerResume: ResumeAnswer = { outcome: 'invalid' };

	private constructor(private wss: WebSocketServer) {
		wss.on('connection', (socket) => {
			const session = new GatewaySession(socket, {
				nextSessionId: () => `session-${++this.identified}`,
				answerResume: (request) => {
					this.resumes.push(request);

					return this.answerResume;
				},
			});

			void session.established.then(() => this.sessions.push(session));
		});
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
	 * The next client session, once it identified or resumed.
	 *
	 * @returns The session.
	 */
	nextSession(): Promise<GatewaySession> {
		return this.sessions.next();
	}

	async close(): Promise<void> {
		for (const socket of this.wss.clients) {
			socket.terminate();
		}

		await new Promise((resolve) => this.wss.close(resolve));
	}
}

export type { GatewaySession };
