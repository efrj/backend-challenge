import { describe, expect, it } from "bun:test";
import { MetricsService } from "../../src/infrastructure/observability/metrics.service";
import {
  isTelemetryStarted,
  withSpan,
} from "../../src/infrastructure/observability/telemetry";
import { WagerTransactionKind, WagerTransactionStatus } from "../../src/domain/wagering/wager-transaction";

describe("OpenTelemetry wiring", () => {
  it("does not start export unless OTEL_ENABLED=true", () => {
    expect(isTelemetryStarted()).toBe(false);
  });

  it("runs the function without a collector when telemetry is off", async () => {
    const value = await withSpan("unit.noop", { "test.case": "off" }, async () => 7);
    expect(value).toBe(7);
  });

  it("keeps the in-process Prometheus metrics when the OTLP exporter is off", () => {
    const metrics = new MetricsService();
    metrics.recordTransactionStatus(
      WagerTransactionStatus.Processed,
      WagerTransactionKind.Bet,
    );
    metrics.recordDuplicate("http_idempotency");
    metrics.recordRetry("outbox_publish");
    metrics.recordDlqMessage();
    metrics.recordLockConflict();
    metrics.updateOutboxLag(1.5, 2);
    metrics.recordProcessingLatency(12);
    metrics.recordAuthAttempt("authenticated");
    metrics.recordAuthAttempt("unauthorized");
    metrics.recordAuthForbidden("provider-a", "provider-b");

    const text = metrics.toPrometheusText();
    expect(text).toContain('wager_transactions_total{status="PROCESSED"} 1');
    expect(text).toContain('wager_duplicates_detected_total{source="http_idempotency"} 1');
    expect(text).toContain('wager_retries_total{type="outbox_publish"} 1');
    expect(text).toContain("wager_dlq_messages_total 1");
    expect(text).toContain("wager_lock_conflicts_total 1");
    expect(text).toContain("wager_outbox_lag_seconds 1.5");
    expect(text).toContain("wager_outbox_pending_count 2");
    expect(text).toContain('wager_auth_attempts_total{status="authenticated"} 1');
    expect(text).toContain('wager_auth_attempts_total{status="unauthorized"} 1');
    expect(text).toContain("wager_auth_forbidden_total 1");
  });
});
