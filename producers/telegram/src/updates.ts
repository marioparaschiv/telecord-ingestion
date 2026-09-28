import {
	PeersIndex,
	getMarkedPeerId,
	type RawUpdateInfo,
	type TelegramClient,
	type tl,
} from '@mtcute/node';

import {
	TELEGRAM_FORWARDED_UPDATES,
	type TelegramForwardedUpdate,
	type TelegramUpdatePayload,
} from '@telecord/ingest-client/telegram';
import {
	asError,
	createTaggedLogger,
	isAllowed,
	type Filter,
	type Outbox,
	type OutboxCapture,
} from '@telecord/producer-core';

import { fetchFullChat, replaceMinPeers, subjectOfMarkedId } from './peers';
import { deserialize, serialize } from './tl';

type ForwardedUpdate = Extract<tl.TypeUpdate, { _: TelegramForwardedUpdate }>;

const FORWARDED_UPDATES = new Set<string>(TELEGRAM_FORWARDED_UPDATES);

/** Updates the server must receive with the full, non-min chat they concern. */
const FULL_CHAT_UPDATES = new Set<string>([
	'updateChannel',
	'updateChat',
	'updateChatDefaultBannedRights',
	'updateChatParticipants',
	'updateChatParticipant',
	'updateChannelParticipant',
	'updateMessageReactions',
] satisfies TelegramForwardedUpdate[]);

function isForwarded(update: tl.TypeUpdate): update is ForwardedUpdate {
	return FORWARDED_UPDATES.has(update._);
}

/** The marked id of the chat an update concerns, or undefined when Telegram leaves it out. */
function chatIdOf(update: ForwardedUpdate): number | undefined {
	switch (update._) {
		case 'updateNewMessage':
		case 'updateNewChannelMessage':
		case 'updateEditMessage':
		case 'updateEditChannelMessage': {
			const { peerId } = update.message;

			return peerId && getMarkedPeerId(peerId);
		}

		// Deletions outside channels carry only message ids, which are unique per account.
		case 'updateDeleteMessages':
			return undefined;

		case 'updateDeleteChannelMessages':
		case 'updateChannel':
		case 'updateChannelParticipant':
			return getMarkedPeerId(update.channelId, 'channel');

		case 'updateChat':
		case 'updateChatParticipant':
			return getMarkedPeerId(update.chatId, 'chat');

		case 'updateChatParticipants':
			return getMarkedPeerId(update.participants.chatId, 'chat');

		case 'updateChatDefaultBannedRights':
		case 'updateMessageReactions':
			return getMarkedPeerId(update.peer);
	}
}

/** The marked id of the channel a too-long difference is for, from the dialog it carries. */
function channelOf({ dialog }: tl.updates.RawChannelDifferenceTooLong): number {
	if (dialog._ !== 'dialog') {
		throw new TypeError(`Expected the channel's dialog, got ${dialog._}`);
	}

	return getMarkedPeerId(dialog.peer);
}

function boxUpdate(update: ForwardedUpdate, peers: PeersIndex): Uint8Array<ArrayBuffer> {
	return serialize({
		_: 'updates',
		updates: [update],
		users: [...peers.users.values()],
		chats: [...peers.chats.values()],
		date: Math.floor(Date.now() / 1000),
		seq: 0,
	});
}

type UpdateForwarderOptions = {
	client: TelegramClient;
	filter: Filter;
	/** Holds each update from the moment mtcute emits it until its frame is stored. */
	outbox: Outbox;
	/** Stores the frame built from a capture, releasing the capture with it. */
	send: (payload: TelegramUpdatePayload, capture: number) => void;
};

/**
 * Turns the session's raw updates into `UPDATE` frames. mtcute has already
 * expanded short updates and recovered gaps; each forwarded update is boxed
 * in its own `updates` container with its peers, min peers replaced by the
 * session's complete copies and, for chat state and reactions, the full chat.
 *
 * mtcute emits an update synchronously and saves its update state at the end
 * of the tick, so each update is captured in the outbox before its handler
 * returns; building the frame takes lookups and is done afterwards. Captures a
 * previous run left unfinished are forwarded first, once `start` is called.
 *
 * Updates are handled one at a time, in the order mtcute emitted them, so a
 * chat fetched for one update never lets a later update overtake it.
 *
 * @param options - The session, the filter rules, the outbox and where frames go.
 * @returns The handlers to register on the client, and `start` to call once the session is ready.
 */
export function createUpdateForwarder({ client, filter, outbox, send }: UpdateForwarderOptions) {
	const logger = createTaggedLogger('Telegram Updates');
	const { promise: started, resolve: start } = Promise.withResolvers<void>();
	let queue = started;

	function enqueue(
		label: string,
		capture: number,
		task: () => Promise<TelegramUpdatePayload | undefined>,
	): void {
		queue = queue
			.then(task)
			.then((payload) => (payload ? send(payload, capture) : outbox.release(capture)))
			.catch((error) => {
				logger.error(
					`Failed to forward ${label}, keeping it for the next start: ${asError(error).message}`,
				);
			});
	}

	async function attachFullChat(
		update: ForwardedUpdate,
		chatId: number,
		peers: PeersIndex,
	): Promise<void> {
		try {
			const chat = await fetchFullChat(client, chatId);

			if (chat) {
				peers.chats.set(chat.id, chat);

				return;
			}

			logger.warn(
				`Forwarding ${update._} without the full chat ${chatId}: it is not in the session`,
			);
		} catch (error) {
			logger.warn(
				`Forwarding ${update._} without the full chat ${chatId}: ${asError(error).message}`,
			);
		}
	}

	async function forwardUpdate(
		update: ForwardedUpdate,
		peers: PeersIndex,
	): Promise<TelegramUpdatePayload | undefined> {
		const chatId = chatIdOf(update);
		const chat = chatId === undefined ? {} : await subjectOfMarkedId(client, chatId, peers);

		if (!isAllowed(filter, { ...chat, update: update._ })) {
			return undefined;
		}

		await replaceMinPeers(client, peers);

		if (chatId !== undefined && chatId < 0 && FULL_CHAT_UPDATES.has(update._)) {
			await attachFullChat(update, chatId, peers);
		}

		return { data: boxUpdate(update, peers) };
	}

	/** A channel gap too long to replay: its difference is forwarded whole, with its recent messages. */
	async function forwardChannelTooLong(
		difference: tl.updates.RawChannelDifferenceTooLong,
	): Promise<TelegramUpdatePayload | undefined> {
		const peers = PeersIndex.from(difference);
		const subject = await subjectOfMarkedId(client, channelOf(difference), peers);

		if (!isAllowed(filter, subject)) {
			return undefined;
		}

		await replaceMinPeers(client, peers);

		return {
			data: serialize({
				...difference,
				users: [...peers.users.values()],
				chats: [...peers.chats.values()],
			}),
		};
	}

	function enqueueUpdate(update: ForwardedUpdate, peers: PeersIndex, capture: number): void {
		enqueue(update._, capture, () => forwardUpdate(update, peers));
	}

	function enqueueChannelTooLong(
		difference: tl.updates.RawChannelDifferenceTooLong,
		capture: number,
	): void {
		enqueue('a channel difference', capture, () => forwardChannelTooLong(difference));
	}

	function replay({ id, data }: OutboxCapture): void {
		const captured = deserialize(data);

		switch (captured._) {
			case 'updates.channelDifferenceTooLong':
				enqueueChannelTooLong(captured, id);

				return;

			case 'updates': {
				const [update] = captured.updates;

				if (update && isForwarded(update)) {
					enqueueUpdate(update, PeersIndex.from(captured), id);

					return;
				}
			}
		}

		logger.error(`Discarded capture ${id}: ${captured._} is not a forwarded update`);
		outbox.release(id);
	}

	for (const capture of outbox.captures()) {
		replay(capture);
	}

	return {
		start,
		onRawUpdate({ update, peers }: RawUpdateInfo): void {
			if (isForwarded(update)) {
				enqueueUpdate(update, peers, outbox.capture(boxUpdate(update, peers)));
			}
		},
		onChannelTooLong(difference: tl.updates.RawChannelDifferenceTooLong): void {
			enqueueChannelTooLong(difference, outbox.capture(serialize(difference)));
		},
	};
}
