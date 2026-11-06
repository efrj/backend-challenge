import {
  context,
  metrics,
  SpanStatusCode,
  trace,
  ValueType,
} from "@opentelemetry/api";
import type { Counter, Histogram } from "@opentelemetry/api";
import { AsyncLocalStorageContextManager } from "@opentelemetry/context-async-hooks";
import { OTLPMetricExporter } from "@opentelemetry/exporter-metrics-otlp-http";
import { OTLPTraceExporter } from "@opentelemetry/exporter-trace-otlp-http";
import { resourceFromAttributes } from "@opentelemetry/resources";
import {
  MeterProvider,
  PeriodicExportingMetricReader,
} from "@opentelemetry/sdk-metrics";
import {
  BatchSpanProcessor,
  TracerProvider,
} from "@opentelemetry/sdk-trace";
import {
  ATTR_SERVICE_NAME,
  ATTR_SERVICE_VERSION,
} from "@opentelemetry/semantic-conventions";
import { getAppConfig } from "../config/app-config";

const INSTRUMENTATION_NAME = "wagering-processor";

interface Instruments {
  transactions: Counter;
  duplicates: Counter;
  retries: Counter;
  dlq: Counter;
  lockConflicts: Counter;
  idempotencyConflicts: Counter;
  reconciliationDiscrepancies: Counter;
  authAttempts: Counter;
  authForbidden: Counter;
  latency: Histogram;
}

interface OutboxGaugeState {
  lagSeconds: number;
  pendingCount: number;
}

let started = false;
let tracerProvider: TracerProvider | undefined;
let meterProvider: MeterProvider | undefined;
let instruments: Instruments | undefined;
const outboxGauge: OutboxGaugeState = { lagSeconds: 0, pendingCount: 0 };

export function isTelemetryStarted(): boolean {
  return started;
}

/**
 * Starts OTLP export of traces and metrics when OTEL_ENABLED=true.
 * A collector outage must not stop wager processing: init failures disable telemetry.
 */
export async function startTelemetry(): Promise<void> {
  if (started) return;

  const config = getAppConfig();
  if (!config.otel.enabled) return;

  try {
    const resource = resourceFromAttributes({
      [ATTR_SERVICE_NAME]: config.otel.serviceName,
      [ATTR_SERVICE_VERSION]: "1.0.0",
      "service.instance.id": config.instanceId,
    });

    context.setGlobalContextManager(new AsyncLocalStorageContextManager());

    tracerProvider = new TracerProvider({
      resource,
      spanProcessors: [
        new BatchSpanProcessor({
          exporter: new OTLPTraceExporter({
            url: `${config.otel.endpoint}/v1/traces`,
          }),
        }),
      ],
    });
    trace.setGlobalTracerProvider(tracerProvider);

    meterProvider = new MeterProvider({
      resource,
      readers: [
        new PeriodicExportingMetricReader({
          exporter: new OTLPMetricExporter({
            url: `${config.otel.endpoint}/v1/metrics`,
          }),
          exportIntervalMillis: config.otel.exportIntervalMs,
        }),
      ],
    });
    metrics.setGlobalMeterProvider(meterProvider);
    instruments = createInstruments(meterProvider);
    started = true;
  } catch (err) {
    started = false;
    instruments = undefined;
    process.stderr.write(
      `${JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "ERROR",
        message: "OpenTelemetry failed to start; continuing without export",
        error: err instanceof Error ? err.message : String(err),
      })}\n`,
    );
  }
}

export async function shutdownTelemetry(): Promise<void> {
  if (!started) return;
  started = false;
  instruments = undefined;
  await Promise.allSettled([
    tracerProvider?.shutdown(),
    meterProvider?.shutdown(),
  ]);
  tracerProvider = undefined;
  meterProvider = undefined;
}

export async function withSpan<T>(
  name: string,
  attributes: Record<string, string | number | boolean>,
  fn: () => Promise<T>,
): Promise<T> {
  if (!started) return fn();

  const span = trace.getTracer(INSTRUMENTATION_NAME).startSpan(name, {
    attributes,
  });
  return context.with(trace.setSpan(context.active(), span), async () => {
    try {
      const result = await fn();
      span.setStatus({ code: SpanStatusCode.OK });
      return result;
    } catch (err) {
      span.setAttribute(
        "error.type",
        err instanceof Error ? err.name : "Error",
      );
      span.setStatus({ code: SpanStatusCode.ERROR });
      throw err;
    } finally {
      span.end();
    }
  });
}

export function recordOtelTransaction(status: string, kind: string): void {
  instruments?.transactions.add(1, { status, kind });
}

export function recordOtelDuplicate(source: string): void {
  instruments?.duplicates.add(1, { source });
}

export function recordOtelRetry(type: string): void {
  instruments?.retries.add(1, { type });
}

export function recordOtelDlq(): void {
  instruments?.dlq.add(1);
}

export function recordOtelLockConflict(): void {
  instruments?.lockConflicts.add(1);
}

export function recordOtelIdempotencyConflict(): void {
  instruments?.idempotencyConflicts.add(1);
}

export function recordOtelReconciliationDiscrepancy(): void {
  instruments?.reconciliationDiscrepancies.add(1);
}

export function recordOtelAuthAttempt(status: "authenticated" | "unauthorized" | "anonymous"): void {
  instruments?.authAttempts.add(1, { status });
}

export function recordOtelAuthForbidden(providerId?: string, targetProviderId?: string): void {
  instruments?.authForbidden.add(1, {
    caller_provider: providerId ?? "unknown",
    target_provider: targetProviderId ?? "unknown",
  });
}

export function recordOtelLatency(durationMs: number): void {
  instruments?.latency.record(durationMs);
}

export function setOtelOutboxLag(lagSeconds: number, pendingCount: number): void {
  outboxGauge.lagSeconds = lagSeconds;
  outboxGauge.pendingCount = pendingCount;
}

function createInstruments(provider: MeterProvider): Instruments {
  const meter = provider.getMeter(INSTRUMENTATION_NAME);
  const transactions = meter.createCounter("otel.wager.transactions", {
    description: "Wager transactions by status and kind",
  });
  const duplicates = meter.createCounter("otel.wager.duplicates", {
    description: "Duplicate HTTP requests or SQS messages",
  });
  const retries = meter.createCounter("otel.wager.retries", {
    description: "Retries by category",
  });
  const dlq = meter.createCounter("otel.wager.dlq_messages", {
    description: "Messages routed to the DLQ",
  });
  const lockConflicts = meter.createCounter("otel.wager.lock_conflicts", {
    description: "Database lock conflicts",
  });
  const idempotencyConflicts = meter.createCounter(
    "otel.wager.idempotency_conflicts",
    { description: "Idempotency keys reused with a different payload" },
  );
  const reconciliationDiscrepancies = meter.createCounter(
    "otel.wager.reconciliation_discrepancies",
    { description: "Wallets whose stored balance disagrees with the ledger" },
  );
  const authAttempts = meter.createCounter("otel.wager.auth_attempts", {
    description: "Authentication outcomes (authenticated, unauthorized, anonymous)",
  });
  const authForbidden = meter.createCounter("otel.wager.auth_forbidden", {
    description: "Forbidden authorization attempts (cross-provider/tenant violation)",
  });
  const latency = meter.createHistogram("otel.wager.processing_duration", {
    description: "Wager processing latency",
    unit: "ms",
    valueType: ValueType.DOUBLE,
  });

  const lag = meter.createObservableGauge("otel.wager.outbox.lag", {
    description: "Age of the oldest unpublished outbox message",
    unit: "s",
  });
  lag.addCallback((result) => {
    result.observe(outboxGauge.lagSeconds);
  });

  const pending = meter.createObservableGauge("otel.wager.outbox.pending", {
    description: "Unpublished outbox messages",
  });
  pending.addCallback((result) => {
    result.observe(outboxGauge.pendingCount);
  });

  return {
    transactions,
    duplicates,
    retries,
    dlq,
    lockConflicts,
    idempotencyConflicts,
    reconciliationDiscrepancies,
    authAttempts,
    authForbidden,
    latency,
  };
}
