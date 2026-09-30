import {
	AggregationTemporality,
	DataPointType,
	InMemoryMetricExporter,
	MeterProvider,
	PeriodicExportingMetricReader,
} from '@opentelemetry/sdk-metrics';
import { afterAll, afterEach, beforeAll, describe, expect, it, onTestFinished, vi } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { metrics } from '@opentelemetry/api';
import { DatabaseSync } from 'node:sqlite';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { TelegramOpcode } from '@telecord/ingest-client/telegram';
import { IngestOpcode } from '@telecord/ingest-client';

import { FakeIngestServer } from '../src/testing';
import IngestConnection from '../src/connection';
import Outbox from '../src/outbox';

const reader = new PeriodicExportingMetricReader({
	exporter: new InMemoryMetricExporter(AggregationTemporality.CUMULATIVE),
	// Collected by hand; the interval never elapses within a test.
	exportIntervalMillis: 3_600_000,
});
const provider = new MeterProvider({ readers: [reader] });

let server: FakeIngestServer;
let outbox: Outbox;
let connection: IngestConnection | undefined;

/** Every data point of a metric, by the attributes it was recorded under. */
async function points(name: string) {
	const { resourceMetrics } = await reader.collect();
	const metric = resourceMetrics.scopeMetrics
		.flatMap((scope) => scope.metrics)
		.find((candidate) => candidate.descriptor.name === name);

	if (!metric) {
		return [];
	}

	if (metric.dataPointType === DataPointType.HISTOGRAM) {
		return metric.dataPoints.map(({ attributes, value }) => ({
			attributes,
			count: value.count,
		}));
	}

	return metric.dataPoints.map(({ attributes, value }) => ({ attributes, value }));
}

/** Acknowledgements timed so far; the histogram is cumulative across tests. */
async function timedAcknowledgements(): Promise<number> {
	const [point] = await points('producer.event.ack.duration');

	return point && 'count' in point ? point.count : 0;
}

function connect(): IngestConnection {
	connection = new IngestConnection({
		url: server.url,
		apiKey: 'tc_key',
		route: '/telegram/v1',
		versionParam: 'layer',
		version: 229,
		outbox,
		window: 500,
		identify: async () => ({ _: 'user', id: 7, self: true }),
		requests: {},
		onFatal: () => {},
	});
	connection.start();

	return connection;
}

beforeAll(() => {
	metrics.setGlobalMeterProvider(provider);
});

afterEach(async () => {
	connection?.stop();
	connection = undefined;
	outbox.close();
	await server.close();
});

afterAll(async () => {
	await provider.shutdown();
	metrics.disable();
});

describe('producer metrics', () => {
	it('reports captures and events held in the outbox', async () => {
		server = await FakeIngestServer.start();
		outbox = new Outbox(':memory:');

		const kept = outbox.capture(new Uint8Array([1]));

		outbox.capture(new Uint8Array([2]));
		outbox.release(kept);
		outbox.append(() => new Uint8Array([3]));

		expect(await points('producer.outbox.captures')).toEqual([{ attributes: {}, value: 1 }]);
		expect(await points('producer.outbox.events')).toEqual([{ attributes: {}, value: 1 }]);
	});

	it('times only the events stored after an older outbox file gains its timestamp columns', async () => {
		server = await FakeIngestServer.start();

		const directory = mkdtempSync(join(tmpdir(), 'outbox-'));
		const path = join(directory, 'outbox.sqlite');
		const old = new DatabaseSync(path);

		onTestFinished(() => rmSync(directory, { recursive: true, force: true }));
		old.exec(
			'CREATE TABLE events (seq INTEGER PRIMARY KEY AUTOINCREMENT, frame BLOB NOT NULL) STRICT',
		);
		old.prepare('INSERT INTO events (frame) VALUES (?)').run(new Uint8Array([1]));
		old.close();

		const timed = await timedAcknowledgements();

		outbox = new Outbox(path);
		outbox.append(() => new Uint8Array([2]));
		outbox.acknowledge(2);

		expect(outbox.size).toBe(0);
		expect(await timedAcknowledgements()).toBe(timed + 1);
	});

	it('reports events in flight, the connected state and the time to acknowledgement', async () => {
		server = await FakeIngestServer.start();
		outbox = new Outbox(':memory:');
		connect();

		const socket = await server.nextConnection();

		socket.hello();
		await socket.ready(0);

		for (const id of [1, 2, 3]) {
			connection?.send(TelegramOpcode.UPDATE, { data: new Uint8Array([id]) });
		}

		for (let index = 0; index < 3; index++) {
			await socket.nextFrame();
		}

		expect(await points('producer.connection.connected')).toEqual([
			{ attributes: {}, value: 1 },
		]);
		expect(await points('producer.events.in_flight')).toEqual([{ attributes: {}, value: 3 }]);

		const timed = await timedAcknowledgements();

		socket.send(IngestOpcode.ACK, { seq: 2 });

		await vi.waitFor(async () =>
			expect(await points('producer.events.in_flight')).toEqual([
				{ attributes: {}, value: 1 },
			]),
		);
		expect(await timedAcknowledgements()).toBe(timed + 2);
	});

	it('counts reconnects by close code and reports the connection down', async () => {
		server = await FakeIngestServer.start();
		outbox = new Outbox(':memory:');
		connect();

		const socket = await server.nextConnection();

		socket.hello();
		await socket.ready(0);
		socket.close(1011, 'INTERNAL_ERROR');

		await vi.waitFor(async () =>
			expect(await points('producer.connection.reconnects')).toEqual([
				{ attributes: { 'close.code': 1011 }, value: 1 },
			]),
		);
		expect(await points('producer.connection.connected')).toContainEqual({
			attributes: {},
			value: 0,
		});
	});
});
