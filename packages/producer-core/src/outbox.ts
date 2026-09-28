import { DatabaseSync } from 'node:sqlite';
import { randomUUID } from 'node:crypto';

/** The outbox's file name under a producer's data directory. */
export const OUTBOX_FILE = 'outbox.sqlite';

const STREAM_ID_KEY = 'stream_id';

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL) STRICT;
	CREATE TABLE IF NOT EXISTS events (seq INTEGER PRIMARY KEY AUTOINCREMENT, frame BLOB NOT NULL) STRICT;
	CREATE TABLE IF NOT EXISTS captures (id INTEGER PRIMARY KEY AUTOINCREMENT, data BLOB NOT NULL) STRICT;
	CREATE TABLE IF NOT EXISTS session_log (id INTEGER PRIMARY KEY AUTOINCREMENT, key TEXT UNIQUE, data TEXT NOT NULL) STRICT;
`;

export type OutboxEvent = { seq: number; frame: Uint8Array };

export type OutboxCapture = { id: number; data: Uint8Array };

/**
 * A producer's stream, durable in SQLite: every forwarded event under its
 * `seq`, kept until the server acknowledges it, and the stream id the server
 * knows the stream by, generated once when the file is created.
 *
 * Captures hold raw input that is persisted synchronously but turned into an
 * event only later, asynchronously; appending the event releases its capture in
 * the same transaction, so a crash in between replays the capture rather than
 * losing or duplicating the event.
 */
class Outbox {
	private db: DatabaseSync;
	readonly streamId: string;

	/** @param path - The database file, or `:memory:`. */
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec('PRAGMA journal_mode = WAL');
		this.db.exec(SCHEMA);
		this.db
			.prepare('INSERT OR IGNORE INTO meta (key, value) VALUES (?, ?)')
			.run(STREAM_ID_KEY, randomUUID());

		this.streamId = String(this.getMeta(STREAM_ID_KEY));
	}

	/** How many events wait for their `ACK`. */
	get size(): number {
		return Number(this.db.prepare('SELECT count(*) AS size FROM events').get()?.size);
	}

	/**
	 * Stores raw input to be turned into an event later.
	 *
	 * @returns The capture's id, which releases it.
	 */
	capture(data: Uint8Array): number {
		const { lastInsertRowid } = this.db
			.prepare('INSERT INTO captures (data) VALUES (?)')
			.run(data);

		return Number(lastInsertRowid);
	}

	/** Every capture not yet released, oldest first. */
	captures(): OutboxCapture[] {
		return this.db
			.prepare('SELECT id, data FROM captures ORDER BY id')
			.all()
			.map((row) => ({ id: Number(row.id), data: toBytes(row.data) }));
	}

	/** Drops a capture that produced no event. */
	release(capture: number): void {
		this.db.prepare('DELETE FROM captures WHERE id = ?').run(capture);
	}

	/**
	 * Stores an event under the next `seq`.
	 *
	 * @param encode - Builds the event's frame under its `seq`, or returns undefined to store nothing.
	 * @param capture - The capture the event was built from, released with it.
	 * @returns The event's `seq`, or undefined when nothing was stored.
	 */
	append(encode: (seq: number) => Uint8Array | undefined, capture?: number): number | undefined {
		return this.transaction(() => {
			if (capture !== undefined) {
				this.release(capture);
			}

			const seq = this.lastSeq() + 1;
			const frame = encode(seq);

			if (frame === undefined) {
				return undefined;
			}

			this.db.prepare('INSERT INTO events (seq, frame) VALUES (?, ?)').run(seq, frame);

			return seq;
		});
	}

	/**
	 * The events after a `seq`, in order.
	 *
	 * @param seq - The last event not to read.
	 * @param limit - The most events to read.
	 */
	after(seq: number, limit: number): OutboxEvent[] {
		return this.db
			.prepare('SELECT seq, frame FROM events WHERE seq > ? ORDER BY seq LIMIT ?')
			.all(seq, limit)
			.map((row) => ({ seq: Number(row.seq), frame: toBytes(row.frame) }));
	}

	/** Deletes every event up to and including `seq`, which the server has stored. */
	acknowledge(seq: number): void {
		this.db.prepare('DELETE FROM events WHERE seq <= ?').run(seq);
	}

	/** Numbers the next event past `seq` when the server's stream is ahead of this outbox. */
	fastForward(seq: number): void {
		if (seq <= this.lastSeq()) {
			return;
		}

		// AUTOINCREMENT keeps the highest seq ever used in `sqlite_sequence`, so numbering resumes there.
		this.transaction(() => {
			this.db.prepare("DELETE FROM sqlite_sequence WHERE name = 'events'").run();
			this.db
				.prepare("INSERT INTO sqlite_sequence (name, seq) VALUES ('events', ?)")
				.run(seq);
		});
	}

	/** A value the producer keeps beside its stream, or undefined when none is stored. */
	getMeta(key: string): string | undefined {
		const row = this.db.prepare('SELECT value FROM meta WHERE key = ?').get(key);

		return row === undefined ? undefined : String(row.value);
	}

	setMeta(key: string, value: string): void {
		this.db
			.prepare(
				'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
			)
			.run(key, value);
	}

	deleteMeta(key: string): void {
		this.db.prepare('DELETE FROM meta WHERE key = ?').run(key);
	}

	/**
	 * Appends an entry to the log a producer restores its platform session from.
	 *
	 * @param data - The entry.
	 * @param key - Replaces the entry logged under the same key, which is dropped from its place.
	 */
	logSession(data: string, key?: string): void {
		this.transaction(() => {
			if (key !== undefined) {
				this.db.prepare('DELETE FROM session_log WHERE key = ?').run(key);
			}

			this.db
				.prepare('INSERT INTO session_log (key, data) VALUES (?, ?)')
				.run(key ?? null, data);
		});
	}

	/** The session log, oldest entry first. */
	sessionLog(): string[] {
		return this.db
			.prepare('SELECT data FROM session_log ORDER BY id')
			.all()
			.map((row) => String(row.data));
	}

	clearSessionLog(): void {
		this.db.prepare('DELETE FROM session_log').run();
	}

	close(): void {
		this.db.close();
	}

	private lastSeq(): number {
		const row = this.db.prepare("SELECT seq FROM sqlite_sequence WHERE name = 'events'").get();

		return Number(row?.seq ?? 0);
	}

	private transaction<T>(run: () => T): T {
		this.db.exec('BEGIN IMMEDIATE');

		try {
			const result = run();

			this.db.exec('COMMIT');

			return result;
		} catch (error) {
			this.db.exec('ROLLBACK');
			throw error;
		}
	}
}

function toBytes(value: unknown): Uint8Array {
	if (!(value instanceof Uint8Array)) {
		throw new TypeError('Expected a BLOB column');
	}

	return value;
}

export default Outbox;
