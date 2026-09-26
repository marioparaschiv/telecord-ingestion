/** How many unacknowledged event frames are kept; the protocol asks for about 1000. */
const UNACKED_BUFFER_CAPACITY = 1000;

/**
 * Event frames the server has not acknowledged yet, in the order they were
 * produced. Past capacity the oldest frame is dropped and counted as lost.
 */
class UnackedBuffer {
	private frames = new Map<string, Uint8Array<ArrayBuffer>>();
	/** Frames dropped on overflow since the process started. */
	dropped = 0;

	constructor(private capacity = UNACKED_BUFFER_CAPACITY) {}

	get size(): number {
		return this.frames.size;
	}

	/**
	 * Appends a frame under its nonce.
	 *
	 * @returns The nonce of the frame dropped to make room, if any.
	 */
	push(nonce: string, frame: Uint8Array<ArrayBuffer>): string | undefined {
		this.frames.set(nonce, frame);

		if (this.frames.size <= this.capacity) {
			return undefined;
		}

		const [oldest] = this.frames.keys();

		if (oldest === undefined) {
			return undefined;
		}

		this.frames.delete(oldest);
		this.dropped++;

		return oldest;
	}

	/** The oldest frame still waiting, which is the next one to send. */
	first(): [nonce: string, frame: Uint8Array<ArrayBuffer>] | undefined {
		const [entry] = this.frames.entries();

		return entry;
	}

	has(nonce: string): boolean {
		return this.frames.has(nonce);
	}

	delete(nonce: string): boolean {
		return this.frames.delete(nonce);
	}
}

export default UnackedBuffer;
