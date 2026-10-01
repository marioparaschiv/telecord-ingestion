import {
	PeersIndex,
	getMarkedPeerId,
	parseMarkedPeerId,
	tl,
	type RawUpdateInfo,
	type TelegramClient,
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
import { withSpan } from '@telecord/producer-otel';

import type ChatStore from './chats';

import {
	fetchFullChat,
	fetchFullUser,
	forbiddenChatOf,
	isChat,
	isComplete,
	replaceMinPeers,
	subjectOfMarkedId,
} from './peers';
import { deserialize, serialize } from './tl';

type ForwardedUpdate = Extract<tl.TypeUpdate, { _: TelegramForwardedUpdate }>;

const FORWARDED_UPDATES = new Set<string>(TELEGRAM_FORWARDED_UPDATES);

/**
 * Chat state updates and reactions: once fetching their chat shows the session lost access to it,
 * they are sent with the chat's forbidden constructor, which revokes it on the server.
 */
const CHAT_STATE_UPDATES = new Set<string>([
	'updateChannel',
	'updateChat',
	'updateChatDefaultBannedRights',
	'updateChatParticipants',
	'updateChatParticipant',
	'updateChannelParticipant',
	'updateMessageReactions',
] satisfies TelegramForwardedUpdate[]);

/**
 * Updates the server must receive with the full, non-min chat they concern,
 * which for a private chat is the user. A message or edit can be the first the
 * server hears of a chat, and the full chat is what lets it store that chat.
 */
const FULL_CHAT_UPDATES = new Set<string>([
	...CHAT_STATE_UPDATES,
	...([
		'updateNewMessage',
		'updateNewChannelMessage',
		'updateEditMessage',
		'updateEditChannelMessage',
	] satisfies TelegramForwardedUpdate[]),
]);

/**
 * Updates that only say a chat changed and is to be fetched again. Telegram sends them when the
 * account leaves a chat as well as when it joins, so they say nothing of whether it is in the chat.
 */
const CHAT_REFETCH_UPDATES = new Set<string>([
	'updateChannel',
	'updateChat',
] satisfies TelegramForwardedUpdate[]);

function isForwarded(update: tl.TypeUpdate): update is ForwardedUpdate {
	return FORWARDED_UPDATES.has(update._);
}

/**
 * The marked id of the chat an update concerns, or undefined when Telegram leaves it out. Exhaustive
 * over the forwarded updates, so a newly forwarded one cannot reach the filter without its chat.
 */
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
		case 'updateChannelWebPage':
		case 'updatePinnedChannelMessages':
			return getMarkedPeerId(update.channelId, 'channel');

		case 'updateChat':
		case 'updateChatParticipant':
			return getMarkedPeerId(update.chatId, 'chat');

		case 'updateChatParticipants':
			return getMarkedPeerId(update.participants.chatId, 'chat');

		case 'updateChatDefaultBannedRights':
		case 'updateMessageReactions':
		case 'updatePinnedMessages':
			return getMarkedPeerId(update.peer);

		// A preview names no chat; it is forwarded only for a message the filter let through.
		case 'updateWebPage':
		// A user is no chat, so user updates are filtered by update type alone.
		case 'updateUserName':
		case 'updateUser':
			return undefined;

		default:
			return update satisfies never;
	}
}

/** Whether an update shows the account itself out of the chat it concerns: left, kicked or banned. */
function isOwnDeparture(update: ForwardedUpdate, selfId: number | undefined): boolean {
	switch (update._) {
		case 'updateChatParticipant':
			return update.userId === selfId && !update.newParticipant;

		case 'updateChannelParticipant': {
			const { newParticipant } = update;

			return (
				update.userId === selfId &&
				(!newParticipant ||
					newParticipant._ === 'channelParticipantLeft' ||
					(newParticipant._ === 'channelParticipantBanned' &&
						newParticipant.left === true))
			);
		}

		case 'updateNewMessage':
		case 'updateNewChannelMessage': {
			const { message } = update;

			return (
				message._ === 'messageService' &&
				message.action._ === 'messageActionChatDeleteUser' &&
				message.action.userId === selfId
			);
		}

		default:
			return false;
	}
}

/** The id of the link preview a message is still waiting on, if any. */
function pendingWebPageOf(update: ForwardedUpdate): string | undefined {
	if (!('message' in update) || update.message._ !== 'message') {
		return undefined;
	}

	const { media } = update.message;

	return media?._ === 'messageMediaWebPage' && media.webpage._ === 'webPagePending'
		? media.webpage.id.toString()
		: undefined;
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
	/** Where a bot keeps the chats its updates name, the only list of them it has. */
	chats?: ChatStore;
	/** Stores the frame built from a capture, releasing the capture with it. */
	send: (payload: TelegramUpdatePayload, capture: number) => void;
};

/**
 * Turns the session's raw updates into `UPDATE` frames. mtcute has already
 * expanded short updates and recovered gaps; each forwarded update is boxed
 * in its own `updates` container with its peers, min peers replaced by the
 * session's complete copies and, for messages, chat state and reactions, the
 * full chat, or for a private chat the full user. A chat state update or reaction
 * whose chat the session lost access to carries the chat's forbidden constructor.
 *
 * mtcute emits an update synchronously and saves its update state at the end
 * of the tick, so each update is captured in the outbox before its handler
 * returns; building the frame takes lookups and is done afterwards. Captures a
 * previous run left unfinished are forwarded first, once `start` is called.
 *
 * Updates are handled one at a time, in the order mtcute emitted them, so a
 * chat fetched for one update never lets a later update overtake it.
 *
 * A bot learns the chats it is in from the updates as they are captured, before
 * the filter rules apply: each chat an update names, with the newest message
 * seen in it, until an update shows the bot out of the chat.
 *
 * @param options - The session, the filter rules, the outbox, a bot's learned chats and where
 * frames go.
 * @returns The handlers to register on the client, and `start` to call once the session is ready.
 */
export function createUpdateForwarder({
	client,
	filter,
	outbox,
	chats,
	send,
}: UpdateForwarderOptions) {
	const logger = createTaggedLogger('Telegram Updates');
	const { promise: started, resolve: start } = Promise.withResolvers<void>();
	/**
	 * Link previews that messages the filter let through are waiting on. Kept in memory, so a
	 * preview that finishes loading after a restart is dropped.
	 */
	const pendingWebPages = new Set<string>();
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
		const [kind, id] = parseMarkedPeerId(chatId);
		const shipped = kind === 'user' ? peers.users.get(id) : peers.chats.get(id);

		if (shipped && isComplete(shipped)) {
			return;
		}

		const revocable = kind !== 'user' && CHAT_STATE_UPDATES.has(update._);

		try {
			const full =
				kind === 'user'
					? await fetchFullUser(client, id)
					: await fetchFullChat(client, chatId);

			if (full) {
				if (isChat(full)) {
					peers.chats.set(full.id, full);
				} else {
					peers.users.set(full.id, full);
				}

				return;
			}

			if (revocable) {
				await attachForbiddenChat(update, chatId, peers);

				return;
			}

			logger.warn(
				`Forwarding ${update._} without the full chat ${chatId}: it is not in the session`,
			);
		} catch (error) {
			if (revocable && tl.RpcError.is(error, 'CHANNEL_PRIVATE')) {
				await attachForbiddenChat(update, chatId, peers);

				return;
			}

			logger.warn(
				`Forwarding ${update._} without the full chat ${chatId}: ${asError(error).message}`,
			);
		}
	}

	/** Puts the forbidden constructor of a chat the session lost access to in place of its copy. */
	async function attachForbiddenChat(
		update: ForwardedUpdate,
		chatId: number,
		peers: PeersIndex,
	): Promise<void> {
		const [, id] = parseMarkedPeerId(chatId);
		const held =
			peers.chats.get(id) ?? (await client.storage.peers.getCompleteById(chatId, true));

		peers.chats.set(id, forbiddenChatOf(chatId, held && isChat(held) ? held : undefined));
		logger.warn(
			`Forwarding ${update._} with ${chatId} forbidden: the session lost access to it`,
		);
	}

	/** Whether a loaded preview is one an allowed message waited on, which it then no longer is. */
	function isAwaited(webpage: tl.TypeWebPage): boolean {
		return 'id' in webpage && pendingWebPages.delete(webpage.id.toString());
	}

	async function forwardUpdate(
		update: ForwardedUpdate,
		peers: PeersIndex,
	): Promise<TelegramUpdatePayload | undefined> {
		const chatId = chatIdOf(update);
		const attributes = {
			'telecord.platform': 'telegram',
			'telecord.account.id': client.storage.self.getCached(true)?.userId,
			'telegram.update': update._,
			'telegram.chat.id': chatId,
			'telegram.message.id': 'message' in update ? update.message.id : undefined,
		};

		return withSpan('telegram.update', attributes, async () => {
			if (update._ === 'updateWebPage' && !isAwaited(update.webpage)) {
				return undefined;
			}

			const chat = chatId === undefined ? {} : await subjectOfMarkedId(client, chatId, peers);

			if (!isAllowed(filter, { ...chat, update: update._ })) {
				return undefined;
			}

			const pending = pendingWebPageOf(update);

			if (pending !== undefined) {
				pendingWebPages.add(pending);
			}

			await replaceMinPeers(client, peers);

			if (chatId !== undefined && FULL_CHAT_UPDATES.has(update._)) {
				await attachFullChat(update, chatId, peers);
			}

			return { data: boxUpdate(update, peers) };
		});
	}

	/** A channel gap too long to replay: its difference is forwarded whole, with its recent messages. */
	async function forwardChannelTooLong(
		difference: tl.updates.RawChannelDifferenceTooLong,
	): Promise<TelegramUpdatePayload | undefined> {
		const attributes = {
			'telecord.platform': 'telegram',
			'telecord.account.id': client.storage.self.getCached(true)?.userId,
			'telegram.message.count': difference.messages.length,
		};

		return withSpan('telegram.channel_too_long', attributes, async (span) => {
			const channelId = channelOf(difference);

			span.setAttribute('telegram.chat.id', channelId);

			const peers = PeersIndex.from(difference);
			const subject = await subjectOfMarkedId(client, channelId, peers);

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
		});
	}

	function learnChat(update: ForwardedUpdate): void {
		const chatId = chatIdOf(update);

		if (!chats || chatId === undefined) {
			return;
		}

		if (isOwnDeparture(update, client.storage.self.getCached(true)?.userId)) {
			chats.forget(chatId);
		} else if (!CHAT_REFETCH_UPDATES.has(update._)) {
			chats.learn(chatId, 'message' in update ? update.message.id : 0);
		}
	}

	function enqueueUpdate(update: ForwardedUpdate, peers: PeersIndex, capture: number): void {
		learnChat(update);
		enqueue(update._, capture, () => forwardUpdate(update, peers));
	}

	function enqueueChannelTooLong(
		difference: tl.updates.RawChannelDifferenceTooLong,
		capture: number,
	): void {
		const { dialog } = difference;

		if (dialog._ === 'dialog') {
			chats?.learn(getMarkedPeerId(dialog.peer), dialog.topMessage);
		}

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
