import { z } from 'zod';

import {
	TELEGRAM_FORWARDED_UPDATES,
	type TelegramForwardedUpdate,
} from '@telecord/ingest-client/telegram';

export const PEER_TYPES = ['user', 'group', 'channel'] as const;

export type PeerType = (typeof PEER_TYPES)[number];

/** What the filter rules see of an event, a snapshot chat or a request's chat. */
export type TelegramFilterSubject = {
	peerType?: PeerType;
	/** The marked id: a user as is, a basic group as `-<id>`, a channel as `-100<id>`. */
	peerId?: string;
	/** The update constructor, for events only. */
	update?: TelegramForwardedUpdate;
};

export const TELEGRAM_FILTER_FIELDS = {
	peerType: z.enum(PEER_TYPES),
	peerId: z.string().regex(/^-?\d+$/),
	update: z.enum(TELEGRAM_FORWARDED_UPDATES),
};

/** Private chats are dropped unless the rules say otherwise. */
export const DEFAULT_TELEGRAM_FILTER_RULES = [{ action: 'deny', peerType: 'user' }];
