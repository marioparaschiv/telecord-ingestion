import { composeDrains, createConsoleDrain, initLogger } from '@telecord/producer-core';
import { createLogsDrain } from '@telecord/producer-otel';

// Imported for its side effect before any module that logs, so the drain and
// service identity are in place for the very first event.
initLogger({
	service: process.env.OTEL_SERVICE_NAME ?? 'telecord-telegram-producer',
	silent: true,
	drain: composeDrains(
		[createConsoleDrain(), createLogsDrain()].filter((drain) => drain !== undefined),
	),
});
