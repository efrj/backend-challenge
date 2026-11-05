import { EntityManager } from "@mikro-orm/postgresql";
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { getAppConfig } from "../../infrastructure/config/app-config";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";
import { ProcessWagerTransactionUseCase } from "../use-cases/process-wager-transaction.use-case";

@Injectable()
export class PendingReferenceWorker implements OnModuleInit, OnModuleDestroy {
  private timer?: ReturnType<typeof setInterval>;
  private running = false;
  private inFlightPromise: Promise<number> | null = null;

  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(ProcessWagerTransactionUseCase)
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    @Inject(StructuredLoggerService)
    private readonly logger: StructuredLoggerService,
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
    const intervalMs = getAppConfig().pendingRefPollIntervalMs;
    this.timer = setInterval(() => {
      if (!this.running || this.inFlightPromise) return;
      this.inFlightPromise = this.processDuePendingReferences()
        .catch((err) => {
          this.logger.error("PendingReferenceWorker cycle error", {
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

  async processDuePendingReferences(
    batchSize = 20,
    maxAttempts?: number,
    baseDelayMs?: number,
  ): Promise<number> {
    const fork = this.em.fork();
    const now = new Date();

    const rows = await fork
      .getConnection()
      .execute<Array<{ id: string }>>(
        `SELECT id
         FROM wager_transactions
         WHERE status = 'PENDING_REFERENCE'
           AND (next_retry_at IS NULL OR next_retry_at <= ?)
         ORDER BY created_at ASC
         LIMIT ?`,
        [now.toISOString(), batchSize],
      );

    let processedCount = 0;
    for (const row of rows) {
      try {
        await this.processWagerUseCase.reprocessPendingReference(
          row.id,
          maxAttempts,
          baseDelayMs,
        );
        processedCount += 1;
      } catch (err) {
        this.logger.warn("Error reprocessing PENDING_REFERENCE transaction", {
          transactionId: row.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }

    return processedCount;
  }
}

