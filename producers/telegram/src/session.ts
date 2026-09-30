import type { RpcCallMiddlewareContext, TelegramClient } from '@mtcute/node';
import { isTlRpcError } from '@mtcute/node/utils.js';

import { SessionState, type IngestSessionState } from '@telecord/ingest-client';
import { createTaggedLogger } from '@telecord/producer-core';

/** The error code Telegram answers with once a session's authorization is gone. */
const UNAUTHORIZED = 401;

const logger = createTaggedLogger('Telegram Session');

export type SessionSignals = {
	/** Telegram refused the session's authorization, e.g. `AUTH_KEY_UNREGISTERED` or `SESSION_REVOKED`. */
	onUnauthorized: (reason: string) => void;
	/** mtcute moved its update state past updates it never fetched. */
	onUpdatesSkipped: (reason: string) => void;
};

/**
 * Watches every call the client makes for what its events do not surface:
 * mtcute consumes a 401 and a skipped difference internally.
 *
 * Each call of `updates.getState` through the client resets the update state
 * mtcute holds (none was stored, `PERSISTENT_TIMESTAMP_INVALID`, a pts gap too
 * big to fetch), and `updates.differenceTooLong` or
 * `updates.channelDifferenceTooLong` moves it past what the difference left out.
 *
 * @param signals - The handlers for a refused authorization and skipped updates.
 * @returns The middleware, to install on the client's network.
 */
export function watchCalls({ onUnauthorized, onUpdatesSkipped }: SessionSignals) {
	return async <Context extends Pick<RpcCallMiddlewareContext, 'request'>>(
		context: Context,
		next: (context: Context) => Promise<unknown>,
	): Promise<unknown> => {
		const result = await next(context);

		if (isTlRpcError(result)) {
			if (result.errorCode === UNAUTHORIZED) {
				onUnauthorized(result.errorMessage);
			}

			return result;
		}

		if (context.request._ === 'updates.getState') {
			onUpdatesSkipped('the update state was fetched anew');
		} else if (
			typeof result === 'object' &&
			result !== null &&
			'_' in result &&
			(result._ === 'updates.differenceTooLong' ||
				result._ === 'updates.channelDifferenceTooLong')
		) {
			onUpdatesSkipped(`Telegram answered ${result._}`);
		}

		return result;
	};
}

/**
 * Follows the session for the ingest server: its state, as `SESSION_STATE`
 * reports it, and whether it caught up on every update, as `IDENTIFY` reports it.
 *
 * A dropped connection is `reconnecting` until mtcute is connected again. A 401
 * is `invalid_credentials` and holds until a login starts the updates loop anew.
 * Skipped updates stay skipped for the rest of the run, so every `IDENTIFY`
 * after them asks the server to backfill.
 *
 * @param client - The session.
 * @param report - Receives each state the session enters.
 * @returns The handlers for the signals `watchCalls` raises, and what `IDENTIFY` reports.
 */
export function createSessionMonitor(
	client: TelegramClient,
	report: (state: IngestSessionState) => void,
) {
	let unauthorized = false;
	let skipped = false;
	/** Whether mtcute is catching up: from `updating` to the `connected` that ends it. */
	let catchingUp = false;
	const caughtUpWaiters = new Set<() => void>();

	function settleCaughtUp(): void {
		if (catchingUp) {
			return;
		}

		for (const resolve of caughtUpWaiters) {
			resolve();
		}

		caughtUpWaiters.clear();
	}

	client.onConnectionState.add((state) => {
		catchingUp = state === 'updating' || (catchingUp && state !== 'connected');
		settleCaughtUp();

		// mtcute emits `updating` only as its updates loop starts, which a login does.
		if (state === 'updating') {
			unauthorized = false;
		}

		if (unauthorized) {
			return;
		}

		report({
			state:
				state === 'connecting' || state === 'offline'
					? SessionState.RECONNECTING
					: SessionState.READY,
		});
	});

	return {
		onUnauthorized(reason: string): void {
			logger.error(`Telegram refused the session's authorization (${reason})`);
			unauthorized = true;
			// mtcute stops its updates loop on AUTH_KEY_UNREGISTERED without ending the catch-up.
			catchingUp = false;
			settleCaughtUp();
			report({ state: SessionState.INVALID_CREDENTIALS, reason });
		},

		onUpdatesSkipped(reason: string): void {
			if (!skipped) {
				logger.warn(
					`Updates were skipped (${reason}): the server backfills them after IDENTIFY`,
				);
			}

			skipped = true;
		},

		/** Whether every update since the stored state was fetched. */
		get recovered(): boolean {
			return !skipped;
		},

		/** Whether Telegram refused the session's authorization since the last login. */
		get unauthorized(): boolean {
			return unauthorized;
		},

		/**
		 * Settles once mtcute is not catching up, so `recovered` covers the
		 * catch-up a login starts, or once Telegram refused the authorization,
		 * which ends the catch-up.
		 */
		caughtUp(): Promise<void> {
			return new Promise((resolve) => {
				caughtUpWaiters.add(resolve);
				settleCaughtUp();
			});
		},
	};
}
