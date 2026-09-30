export { SpanStatusCode, metrics, trace, type Attributes, type Span } from '@opentelemetry/api';
export { default as traceRequest } from './trace-request';
export { default as recordError } from './record-error';
export { default as withSpan } from './with-span';
export { createLogsDrain } from './logs-drain';
export { shutdown } from './setup';
