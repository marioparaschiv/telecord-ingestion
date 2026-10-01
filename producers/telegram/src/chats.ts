import { DatabaseSync } from 'node:sqlite';

/** The learned chats' file name under an account's directory. */
export const CHATS_FILE = 'chats.sqlite';

const SCHEMA = `
	CREATE TABLE IF NOT EXISTS chats (peer_id INTEGER PRIMARY KEY, top_message INTEGER NOT NULL) STRICT;
`;

export type LearnedChat = {
	/** The chat's marked id. */
	peerId: number;
	/** The id of the newest message seen in the chat, 0 before any. */
	topMessage: number;
};

/**
 * The chats a bot is in, durable in SQLite. Telegram lists a bot neither its
 * dialogs nor a chat's history, so each chat is learned from the first update
 * that names it and forgotten once the bot is out of it.
 */
class ChatStore {
	private db: DatabaseSync;

	/** @param path - The database file, or `:memory:`. */
	constructor(path: string) {
		this.db = new DatabaseSync(path);
		this.db.exec('PRAGMA journal_mode = WAL');
		this.db.exec(SCHEMA);
	}

	/**
	 * Records a chat, and its newest message when `messageId` is past the one held.
	 *
	 * @param peerId - The chat's marked id.
	 * @param messageId - The id of a message seen in the chat.
	 */
	learn(peerId: number, messageId = 0): void {
		this.db
			.prepare(
				'INSERT INTO chats (peer_id, top_message) VALUES (?, ?) ON CONFLICT (peer_id) DO UPDATE SET top_message = max(top_message, excluded.top_message)',
			)
			.run(peerId, messageId);
	}

	/** @param peerId - The marked id of a chat the bot is no longer in. */
	forget(peerId: number): void {
		this.db.prepare('DELETE FROM chats WHERE peer_id = ?').run(peerId);
	}

	/**
	 * @param peerId - The chat's marked id.
	 * @returns The id of the newest message seen in the chat, or undefined for a chat not learned.
	 */
	topMessage(peerId: number): number | undefined {
		const row = this.db.prepare('SELECT top_message FROM chats WHERE peer_id = ?').get(peerId);

		return row === undefined ? undefined : Number(row.top_message);
	}

	/** Every learned chat, in the order they were learned. */
	all(): LearnedChat[] {
		return this.db
			.prepare('SELECT peer_id, top_message FROM chats ORDER BY rowid')
			.all()
			.map((row) => ({ peerId: Number(row.peer_id), topMessage: Number(row.top_message) }));
	}

	close(): void {
		this.db.close();
	}
}

export default ChatStore;
