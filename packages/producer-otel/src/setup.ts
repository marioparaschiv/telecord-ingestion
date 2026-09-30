import { ATTR_SERVICE_NAME, ATTR_SERVICE_VERSION } from '@opentelemetry/semantic-conventions';
import { PeriodicExportingMetricReader, MeterProvider } from '@opentelemetry/sdk-metrics';
import { NodeTracerProvider, BatchSpanProcessor } from '@opentelemetry/sdk-trace-node';
import { OTLPMetricExporter } from '@opentelemetry/exporter-metrics-otlp-http';
import { UndiciInstrumentation } from '@opentelemetry/instrumentation-undici';
import { OTLPTraceExporter } from '@opentelemetry/exporter-trace-otlp-http';
import { registerInstrumentations } from '@opentelemetry/instrumentation';
import { resourceFromAttributes } from '@opentelemetry/resources';
import { metrics } from '@opentelemetry/api';

import { createTaggedLogger } from '@telecord/producer-core';

import { flushLogsDrains } from './logs-drain';
import parseOtelEnv from './env';

const logger = createTaggedLogger('OTel');

let tracerProvider: NodeTracerProvider | undefined;
let meterProvider: MeterProvider | undefined;

/**
 * Registers the global tracer and meter providers and the undici instrumentation.
 * No-op when telemetry is off.
 *
 * @returns Whether telemetry is on.
 */
export function setup(): boolean {
	const env = parseOtelEnv();

	if (!env) {
		return false;
	}

	// Service identity is owned by OTEL_SERVICE_NAME, so it wins over any
	// same-named key smuggled in through OTEL_RESOURCE_ATTRIBUTES.
	const resource = resourceFromAttributes({
		...env.resourceAttributes,
		[ATTR_SERVICE_NAME]: env.serviceName,
		[ATTR_SERVICE_VERSION]: process.env.npm_package_version ?? 'unknown',
		'deployment.environment.name': process.env.NODE_ENV ?? 'development',
	});

	tracerProvider = new NodeTracerProvider({
		resource,
		spanProcessors: [
			new BatchSpanProcessor(
				new OTLPTraceExporter({ url: `${env.endpoint}/v1/traces`, headers: env.headers }),
			),
		],
	});

	tracerProvider.register();

	meterProvider = new MeterProvider({
		resource,
		readers: [
			new PeriodicExportingMetricReader({
				exporter: new OTLPMetricExporter({
					url: `${env.endpoint}/v1/metrics`,
					headers: env.headers,
				}),
				exportIntervalMillis: 30_000,
			}),
		],
	});

	metrics.setGlobalMeterProvider(meterProvider);

	const { origin } = new URL(env.endpoint);

	registerInstrumentations({
		instrumentations: [
			new UndiciInstrumentation({
				// evlog ships logs with fetch, so exports to the endpoint are excluded to keep
				// traces from describing their own delivery.
				ignoreRequestHook: (request) => request.origin === origin,
			}),
		],
	});

	logger.info(`Initialized (${env.serviceName} → ${env.endpoint})`);

	return true;
}

/**
 * Flushes buffered telemetry and tears down the providers {@link setup} registered.
 * Safe to call when {@link setup} never ran.
 *
 * @returns A promise settling once the log drains and providers have finished.
 */
export async function shutdown(): Promise<void> {
	// Logs flush first so records produced during shutdown still reach the collector.
	await flushLogsDrains();
	await Promise.all([tracerProvider?.shutdown(), meterProvider?.shutdown()]);
}
