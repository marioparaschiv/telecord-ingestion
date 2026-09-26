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
import { asError, createTaggedLogger, isAllowed, type Filter } from '@telecord/producer-core';

import { fetchFullChat, replaceMinPeers, subjectOfMarkedId } from './peers';
import { serialize } from './tl';

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

function boxUpdate(update: ForwardedUpdate, peers: PeersIndex): TelegramUpdatePayload {
	return {
		data: serialize({
			_: 'updates',
			updates: [update],
			users: [...peers.users.values()],
			chats: [...peers.chats.values()],
			date: Math.floor(Date.now() / 1000),
			seq: 0,
		}),
	};
}

type UpdateForwarderOptions = {
	client: TelegramClient;
	filter: Filter;
	send: (payload: TelegramUpdatePayload) => void;
};

/**
 * Turns the session's raw updates into `UPDATE` frames. mtcute has already
 * expanded short updates and recovered gaps; each forwarded update is boxed
 * in its own `updates` container with its peers, min peers replaced by the
 * session's complete copies and, for chat state and reactions, the full chat.
 *
 * Updates are handled one at a time, in the order mtcute emitted them, so a
 * chat fetched for one update never lets a later update overtake it.
 *
 * @param options - The session, the filter rules and where frames go.
 * @returns The handlers to register on the client.
 */
export function createUpdateForwarder({ client, filter, send }: UpdateForwarderOptions) {
	const logger = createTaggedLogger('Telegram Updates');
	let queue = Promise.resolve();

	function enqueue(label: string, task: () => Promise<void>): void {
		queue = queue.then(task).catch((error) => {
			logger.error(`Failed to forward ${label}: ${asError(error).message}`);
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

	async function forwardUpdate({ update, peers }: RawUpdateInfo): Promise<void> {
		if (!isForwarded(update)) {
			return;
		}

		const chatId = chatIdOf(update);
		const chat = chatId === undefined ? {} : await subjectOfMarkedId(client, chatId, peers);

		if (!isAllowed(filter, { ...chat, update: update._ })) {
			return;
		}

		await replaceMinPeers(client, peers);

		if (chatId !== undefined && chatId < 0 && FULL_CHAT_UPDATES.has(update._)) {
			await attachFullChat(update, chatId, peers);
		}

		send(boxUpdate(update, peers));
	}

	/** A channel gap too long to replay: its difference is forwarded whole, with its recent messages. */
	async function forwardChannelTooLong(
		channelId: number,
		difference: tl.updates.RawChannelDifferenceTooLong,
	): Promise<void> {
		const peers = PeersIndex.from(difference);
		const subject = await subjectOfMarkedId(
			client,
			getMarkedPeerId(channelId, 'channel'),
			peers,
		);

		if (!isAllowed(filter, subject)) {
			return;
		}

		await replaceMinPeers(client, peers);

		send({
			data: serialize({
				...difference,
				users: [...peers.users.values()],
				chats: [...peers.chats.values()],
			}),
		});
	}

	return {
		onRawUpdate(info: RawUpdateInfo): void {
			enqueue(info.update._, () => forwardUpdate(info));
		},
		onChannelTooLong(
			channelId: number,
			difference: tl.updates.RawChannelDifferenceTooLong,
		): void {
			enqueue(`the difference of channel ${channelId}`, () =>
				forwardChannelTooLong(channelId, difference),
			);
		},
	};
}
