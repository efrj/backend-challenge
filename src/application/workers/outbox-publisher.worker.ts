import { EntityManager } from "@mikro-orm/postgresql";
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { getAppConfig } from "../../infrastructure/config/app-config";
import { SqsService } from "../../infrastructure/messaging/sqs.service";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";
import {
  OutboxMessageRecord,
  PersistenceMapper,
} from "../../infrastructure/persistence/entities/records";

@Injectable()
export class OutboxPublisherWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private inFlightPromise: Promise<number> | null = null;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(SqsService) private readonly sqsService: SqsService,
    @Inject(StructuredLoggerService)
    private readonly logger: StructuredLoggerService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  onModuleInit(): void {
    if (!getAppConfig().workersEnabled) {
      return;
    }
    this.start();
  }

  async onModuleDestroy(): Promise<void> {
    await this.stop();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const intervalMs = getAppConfig().outboxPollIntervalMs;
    this.timer = setInterval(() => {
      if (!this.running || this.inFlightPromise) return;
      this.inFlightPromise = this.publishBatch()
        .catch((err) => {
          this.logger.error("OutboxPublisherWorker cycle error", {
            error: err instanceof Error ? err.message : String(err),
          });
          return 0;
        })
        .finally(() => {
          this.inFlightPromise = null;
        });
    }, intervalMs);
  }

  async stop(): Promise<void> {
    this.running = false;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.inFlightPromise) {
      await this.inFlightPromise;
    }
  }

  /**
   * Claims a batch of due unpublished outbox messages using FOR UPDATE SKIP LOCKED,
   * publishes each to SQS, and marks publishedAt (or schedules retry on failure).
   * Safe for multiple concurrent publishers across multiple instances.
   */
  async publishBatch(
    batchSize = 25,
    customPublishFn?: (msg: OutboxMessage) => Promise<void>,
  ): Promise<number> {
    const fork = this.em.fork();
    const now = new Date();
    let publishedCount = 0;

    await fork.transactional(async (txEm) => {
      const trx = txEm.getTransactionContext();
      if (!trx) {
        throw new Error("Outbox publisher requires an active database transaction");
      }

      const rows = await txEm
        .getConnection()
        .execute<
          Array<{
            id: string;
            aggregate_id: string;
            event_type: string;
            payload: Record<string, unknown> | string;
            occurred_at: Date;
            attempts: number;
            next_attempt_at: Date | null;
            published_at: Date | null;
          }>
        >(
          `SELECT id, aggregate_id, event_type, payload, occurred_at, attempts, next_attempt_at, published_at
           FROM outbox_messages
           WHERE published_at IS NULL
             AND (next_attempt_at IS NULL OR next_attempt_at <= ?)
           ORDER BY occurred_at ASC
           LIMIT ?
           FOR UPDATE SKIP LOCKED`,
          [now.toISOString(), batchSize],
          "all",
          trx,
        );

      for (const row of rows) {
        const record = new OutboxMessageRecord();
        record.id = row.id;
        record.aggregateId = row.aggregate_id;
        record.eventType = row.event_type;
        record.payload =
          typeof row.payload === "string"
            ? (JSON.parse(row.payload) as Record<string, unknown>)
            : row.payload;
        record.occurredAt = new Date(row.occurred_at);
        record.attempts = Number(row.attempts ?? 0);
        record.nextAttemptAt = row.next_attempt_at
          ? new Date(row.next_attempt_at)
          : null;
        record.publishedAt = row.published_at
          ? new Date(row.published_at)
          : null;

        const outboxMsg = PersistenceMapper.outboxToDomain(record);

        try {
          if (customPublishFn) {
            await customPublishFn(outboxMsg);
          } else {
            await this.sqsService.publishOutboxEvent(outboxMsg);
          }

          const publishNow = new Date();
          outboxMsg.markPublished(publishNow);
          await txEm
            .getConnection()
            .execute(
              `UPDATE outbox_messages
               SET published_at = ?, next_attempt_at = NULL
               WHERE id = ?`,
              [publishNow.toISOString(), outboxMsg.id],
              "run",
              trx,
            );
          publishedCount += 1;
        } catch (err) {
          const retryNow = new Date();
          outboxMsg.scheduleRetry(retryNow);
          this.metrics.recordRetry("outbox_publish");
          await txEm
            .getConnection()
            .execute(
              `UPDATE outbox_messages
               SET attempts = ?, next_attempt_at = ?
               WHERE id = ?`,
              [
                outboxMsg.attempts,
                outboxMsg.nextAttemptAt?.toISOString() ?? null,
                outboxMsg.id,
              ],
              "run",
              trx,
            );
          this.logger.warn("Failed to publish outbox message; retry scheduled", {
            outboxId: outboxMsg.id,
            eventType: outboxMsg.eventType,
            attempts: outboxMsg.attempts,
            error: err instanceof Error ? err.message : String(err),
          });
        }
      }
    });

    await this.refreshOutboxLagMetrics(fork);
    return publishedCount;
  }

  private async refreshOutboxLagMetrics(fork: EntityManager): Promise<void> {
    try {
      const stats = await fork
        .getConnection()
        .execute<
          Array<{
            pending_count: string;
            oldest_occurred_at: Date | null;
          }>
        >(
          `SELECT
             COUNT(*)::text AS pending_count,
             MIN(occurred_at) AS oldest_occurred_at
           FROM outbox_messages
           WHERE published_at IS NULL`,
        );

      const stat = stats[0];
      const pendingCount = Number(stat?.pending_count ?? 0);
      let lagSeconds = 0;
      if (pendingCount > 0 && stat?.oldest_occurred_at) {
        lagSeconds = Math.max(
          0,
          (Date.now() - new Date(stat.oldest_occurred_at).getTime()) / 1000,
        );
      }
      this.metrics.updateOutboxLag(lagSeconds, pendingCount);
    } catch {
      // ignore metric refresh errors during shutdown
    }
  }
}

