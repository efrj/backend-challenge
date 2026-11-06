import { Injectable } from "@nestjs/common";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import {
  recordOtelDlq,
  recordOtelDuplicate,
  recordOtelIdempotencyConflict,
  recordOtelLatency,
  recordOtelLockConflict,
  recordOtelReconciliationDiscrepancy,
  recordOtelRetry,
  recordOtelTransaction,
  setOtelOutboxLag,
} from "./telemetry";

export interface MetricsSnapshot {
  transactionsByStatus: Record<string, number>;
  transactionsByStatusAndKind: Record<string, number>;
  duplicatesDetected: {
    httpIdempotency: number;
    sqsInbox: number;
    total: number;
  };
  idempotencyConflicts: number;
  retries: {
    sqsTransient: number;
    pendingReference: number;
    outboxPublish: number;
    dbLock: number;
    total: number;
  };
  dlqMessages: number;
  lockConflicts: number;
  reconciliationDiscrepancies: number;
  outboxLagSeconds: number;
  outboxPendingCount: number;
  processingLatencyMs: {
    count: number;
    sum: number;
    avg: number;
    p50: number;
    p95: number;
    p99: number;
    max: number;
  };
}

@Injectable()
export class MetricsService {
  private readonly transactionsByStatus = new Map<string, number>();
  private readonly transactionsByStatusAndKind = new Map<string, number>();
  private httpDuplicates = 0;
  private sqsInboxDuplicates = 0;
  private idempotencyConflicts = 0;
  private sqsTransientRetries = 0;
  private pendingReferenceRetries = 0;
  private outboxPublishRetries = 0;
  private dbLockRetries = 0;
  private dlqMessages = 0;
  private lockConflicts = 0;
  private reconciliationDiscrepancies = 0;
  private outboxLagSeconds = 0;
  private outboxPendingCount = 0;
  private readonly latenciesMs: number[] = [];
  private latencyCount = 0;
  private latencySum = 0;

  constructor() {
    for (const status of Object.values(WagerTransactionStatus)) {
      this.transactionsByStatus.set(status, 0);
    }
  }

  recordTransactionStatus(
    status: WagerTransactionStatus,
    kind: WagerTransactionKind,
  ): void {
    this.transactionsByStatus.set(
      status,
      (this.transactionsByStatus.get(status) ?? 0) + 1,
    );
    const key = `${status}:${kind}`;
    this.transactionsByStatusAndKind.set(
      key,
      (this.transactionsByStatusAndKind.get(key) ?? 0) + 1,
    );
    recordOtelTransaction(status, kind);
  }

  recordDuplicate(source: "http_idempotency" | "sqs_inbox"): void {
    if (source === "http_idempotency") {
      this.httpDuplicates += 1;
    } else {
      this.sqsInboxDuplicates += 1;
    }
    recordOtelDuplicate(source);
  }

  recordIdempotencyConflict(): void {
    this.idempotencyConflicts += 1;
    recordOtelIdempotencyConflict();
  }

  recordRetry(
    type: "sqs_transient" | "pending_reference" | "outbox_publish" | "db_lock",
  ): void {
    switch (type) {
      case "sqs_transient":
        this.sqsTransientRetries += 1;
        break;
      case "pending_reference":
        this.pendingReferenceRetries += 1;
        break;
      case "outbox_publish":
        this.outboxPublishRetries += 1;
        break;
      case "db_lock":
        this.dbLockRetries += 1;
        break;
    }
    recordOtelRetry(type);
  }

  recordDlqMessage(): void {
    this.dlqMessages += 1;
    recordOtelDlq();
  }

  recordLockConflict(): void {
    this.lockConflicts += 1;
    recordOtelLockConflict();
  }

  recordReconciliationDiscrepancy(): void {
    this.reconciliationDiscrepancies += 1;
    recordOtelReconciliationDiscrepancy();
  }

  updateOutboxLag(lagSeconds: number, pendingCount: number): void {
    this.outboxLagSeconds = Math.max(0, Number(lagSeconds.toFixed(3)));
    this.outboxPendingCount = Math.max(0, pendingCount);
    setOtelOutboxLag(this.outboxLagSeconds, this.outboxPendingCount);
  }

  recordProcessingLatency(durationMs: number): void {
    const val = Math.max(0, durationMs);
    this.latencyCount += 1;
    this.latencySum += val;
    this.latenciesMs.push(val);
    if (this.latenciesMs.length > 5000) {
      this.latenciesMs.shift();
    }
    recordOtelLatency(val);
  }

  getSnapshot(): MetricsSnapshot {
    const sorted = [...this.latenciesMs].sort((a, b) => a - b);
    const percentile = (p: number): number => {
      if (sorted.length === 0) return 0;
      const idx = Math.min(
        sorted.length - 1,
        Math.floor((p / 100) * sorted.length),
      );
      return Number((sorted[idx] ?? 0).toFixed(2));
    };

    const statusObj: Record<string, number> = {};
    for (const [k, v] of this.transactionsByStatus.entries()) {
      statusObj[k] = v;
    }

    const statusKindObj: Record<string, number> = {};
    for (const [k, v] of this.transactionsByStatusAndKind.entries()) {
      statusKindObj[k] = v;
    }

    return {
      transactionsByStatus: statusObj,
      transactionsByStatusAndKind: statusKindObj,
      duplicatesDetected: {
        httpIdempotency: this.httpDuplicates,
        sqsInbox: this.sqsInboxDuplicates,
        total: this.httpDuplicates + this.sqsInboxDuplicates,
      },
      idempotencyConflicts: this.idempotencyConflicts,
      retries: {
        sqsTransient: this.sqsTransientRetries,
        pendingReference: this.pendingReferenceRetries,
        outboxPublish: this.outboxPublishRetries,
        dbLock: this.dbLockRetries,
        total:
          this.sqsTransientRetries +
          this.pendingReferenceRetries +
          this.outboxPublishRetries +
          this.dbLockRetries,
      },
      dlqMessages: this.dlqMessages,
      lockConflicts: this.lockConflicts,
      reconciliationDiscrepancies: this.reconciliationDiscrepancies,
      outboxLagSeconds: this.outboxLagSeconds,
      outboxPendingCount: this.outboxPendingCount,
      processingLatencyMs: {
        count: this.latencyCount,
        sum: Number(this.latencySum.toFixed(2)),
        avg:
          this.latencyCount > 0
            ? Number((this.latencySum / this.latencyCount).toFixed(2))
            : 0,
        p50: percentile(50),
        p95: percentile(95),
        p99: percentile(99),
        max: sorted.length > 0 ? Number(sorted[sorted.length - 1]!.toFixed(2)) : 0,
      },
    };
  }

  toPrometheusText(): string {
    const snap = this.getSnapshot();
    const lines: string[] = [];

    lines.push("# HELP wager_transactions_total Total wager transactions by status");
    lines.push("# TYPE wager_transactions_total counter");
    for (const [status, count] of Object.entries(snap.transactionsByStatus)) {
      lines.push(`wager_transactions_total{status="${status}"} ${count}`);
    }

    lines.push("# HELP wager_duplicates_detected_total Duplicate requests or messages detected");
    lines.push("# TYPE wager_duplicates_detected_total counter");
    lines.push(
      `wager_duplicates_detected_total{source="http_idempotency"} ${snap.duplicatesDetected.httpIdempotency}`,
    );
    lines.push(
      `wager_duplicates_detected_total{source="sqs_inbox"} ${snap.duplicatesDetected.sqsInbox}`,
    );

    lines.push("# HELP wager_idempotency_conflicts_total Idempotency key conflicts with divergent payload");
    lines.push("# TYPE wager_idempotency_conflicts_total counter");
    lines.push(`wager_idempotency_conflicts_total ${snap.idempotencyConflicts}`);

    lines.push("# HELP wager_retries_total Total retries by category");
    lines.push("# TYPE wager_retries_total counter");
    lines.push(`wager_retries_total{type="sqs_transient"} ${snap.retries.sqsTransient}`);
    lines.push(`wager_retries_total{type="pending_reference"} ${snap.retries.pendingReference}`);
    lines.push(`wager_retries_total{type="outbox_publish"} ${snap.retries.outboxPublish}`);
    lines.push(`wager_retries_total{type="db_lock"} ${snap.retries.dbLock}`);

    lines.push("# HELP wager_dlq_messages_total Messages routed to Dead Letter Queue");
    lines.push("# TYPE wager_dlq_messages_total counter");
    lines.push(`wager_dlq_messages_total ${snap.dlqMessages}`);

    lines.push("# HELP wager_lock_conflicts_total Database lock conflicts encountered");
    lines.push("# TYPE wager_lock_conflicts_total counter");
    lines.push(`wager_lock_conflicts_total ${snap.lockConflicts}`);

    lines.push("# HELP wager_reconciliation_discrepancies_total Wallet balance vs ledger discrepancies");
    lines.push("# TYPE wager_reconciliation_discrepancies_total counter");
    lines.push(
      `wager_reconciliation_discrepancies_total ${snap.reconciliationDiscrepancies}`,
    );

    lines.push("# HELP wager_outbox_lag_seconds Age in seconds of oldest unpublished outbox message");
    lines.push("# TYPE wager_outbox_lag_seconds gauge");
    lines.push(`wager_outbox_lag_seconds ${snap.outboxLagSeconds}`);

    lines.push("# HELP wager_outbox_pending_count Number of pending outbox messages");
    lines.push("# TYPE wager_outbox_pending_count gauge");
    lines.push(`wager_outbox_pending_count ${snap.outboxPendingCount}`);

    lines.push("# HELP wager_processing_duration_ms Processing latency summary in ms");
    lines.push("# TYPE wager_processing_duration_ms summary");
    lines.push(`wager_processing_duration_ms{quantile="0.5"} ${snap.processingLatencyMs.p50}`);
    lines.push(`wager_processing_duration_ms{quantile="0.95"} ${snap.processingLatencyMs.p95}`);
    lines.push(`wager_processing_duration_ms{quantile="0.99"} ${snap.processingLatencyMs.p99}`);
    lines.push(`wager_processing_duration_ms_sum ${snap.processingLatencyMs.sum}`);
    lines.push(`wager_processing_duration_ms_count ${snap.processingLatencyMs.count}`);

    return `${lines.join("\n")}\n`;
  }
}

