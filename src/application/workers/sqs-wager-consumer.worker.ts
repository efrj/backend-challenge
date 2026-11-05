import { Message } from "@aws-sdk/client-sqs";
import {
  Inject,
  Injectable,
  OnModuleDestroy,
  OnModuleInit,
} from "@nestjs/common";
import { createHash, randomUUID } from "crypto";
import {
  EntityNotFoundError,
  IdempotencyConflictError,
  InvalidMoneyError,
  InvalidTransactionInputError,
  TransientInfrastructureError,
} from "../../domain/errors/domain-errors";
import { WagerTransactionKind } from "../../domain/wagering/wager-transaction";
import {
  SqsService,
  SqsWagerMessageEnvelope,
} from "../../infrastructure/messaging/sqs.service";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";
import { getAppConfig } from "../../infrastructure/config/app-config";
import { ProcessWagerTransactionUseCase } from "../use-cases/process-wager-transaction.use-case";

export const SQS_WAGER_CONSUMER_NAME = "sqs-wager-transaction-consumer";

@Injectable()
export class SqsWagerConsumerWorker implements OnModuleInit, OnModuleDestroy {
  private running = false;
  private pollTimer?: ReturnType<typeof setTimeout>;
  private readonly inFlightMessages = new Map<string, Message>();
  private activeBatchPromise: Promise<number> | null = null;

  /**
   * Optional hook for testing crash recovery ("worker morto depois do commit e antes do ack")
   * or transient error injection.
   */
  public beforeAckHook?: (messageId: string, receiptHandle: string) => Promise<void> | void;
  public beforeProcessHook?: (messageId: string, attemptCount: number) => Promise<void> | void;

  constructor(
    @Inject(SqsService) private readonly sqsService: SqsService,
    @Inject(ProcessWagerTransactionUseCase)
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
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
    await this.gracefulShutdown();
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    this.scheduleNextPoll(50);
  }

  private scheduleNextPoll(delayMs = 150): void {
    if (!this.running) return;
    this.pollTimer = setTimeout(async () => {
      if (!this.running) return;
      try {
        this.activeBatchPromise = this.pollOnce(10, 1);
        const count = await this.activeBatchPromise;
        this.scheduleNextPoll(count > 0 ? 10 : 150);
      } catch (err) {
        this.logger.warn("SQS consumer poll error", {
          error: err instanceof Error ? err.message : String(err),
        });
        this.scheduleNextPoll(500);
      } finally {
        this.activeBatchPromise = null;
      }
    }, delayMs);
  }

  /**
   * Graceful shutdown on SIGTERM / module destroy:
   * 1. Stop polling new messages.
   * 2. Wait up to shutdownTimeoutMs for in-flight messages to finish.
   * 3. Return visibility (VisibilityTimeout = 0) for any message that could not finish.
   */
  async gracefulShutdown(shutdownTimeoutMs = 5000): Promise<void> {
    this.running = false;
    if (this.pollTimer) {
      clearTimeout(this.pollTimer);
      this.pollTimer = undefined;
    }

    if (this.activeBatchPromise) {
      await Promise.race([
        this.activeBatchPromise.catch(() => 0),
        new Promise((resolve) => setTimeout(resolve, shutdownTimeoutMs)),
      ]);
    }

    // Release visibility for any remaining in-flight messages
    for (const [, msg] of this.inFlightMessages.entries()) {
      if (msg.ReceiptHandle) {
        try {
          await this.sqsService.changeWagerMessageVisibility(
            msg.ReceiptHandle,
            0,
          );
        } catch {
          // ignore if already acked
        }
      }
    }
    this.inFlightMessages.clear();
  }

  async pollOnce(
    maxMessages = 10,
    waitTimeSeconds = 0,
  ): Promise<number> {
    const messages = await this.sqsService.receiveWagerMessages(
      maxMessages,
      waitTimeSeconds,
    );
    let handled = 0;

    for (const msg of messages) {
      await this.handleSingleMessage(msg);
      handled += 1;
    }

    return handled;
  }

  async handleSingleMessage(msg: Message): Promise<void> {
    const receiptHandle = msg.ReceiptHandle;
    const sqsMessageId = msg.MessageId ?? randomUUID();
    if (receiptHandle) {
      this.inFlightMessages.set(sqsMessageId, msg);
    }

    try {
      const rawBody = msg.Body ?? "";
      let envelope: SqsWagerMessageEnvelope;

      try {
        envelope = JSON.parse(rawBody) as SqsWagerMessageEnvelope;
      } catch {
        await this.routeToDlq(msg, "MALFORMED_JSON");
        return;
      }

      if (
        !envelope ||
        typeof envelope !== "object" ||
        envelope.type !== "WagerTransactionRequested" ||
        !envelope.data ||
        !envelope.messageId
      ) {
        await this.routeToDlq(msg, "INVALID_ENVELOPE_SCHEMA");
        return;
      }

      const messageId = envelope.messageId;
      const correlationId = envelope.correlationId ?? messageId;
      const receiveCount = Number(
        msg.Attributes?.ApproximateReceiveCount ?? "1",
      );

      if (this.beforeProcessHook) {
        await this.beforeProcessHook(messageId, receiveCount);
      }

      const data = envelope.data;
      const idempotencyKey =
        data.idempotencyKey ??
        `${data.providerId}:${data.externalTransactionId}`;

      const inboxPayloadHash = createHash("sha256")
        .update(rawBody, "utf8")
        .digest("hex");

      const result = await this.processWagerUseCase.execute({
        idempotencyKey,
        providerId: data.providerId,
        externalTransactionId: data.externalTransactionId,
        playerId: data.playerId,
        walletId: data.walletId,
        roundId: data.roundId,
        gameId: data.gameId,
        kind: data.kind as WagerTransactionKind,
        money: data.money,
        referenceExternalTransactionId: data.referenceExternalTransactionId,
        correlationId,
        inbox: {
          consumerName: SQS_WAGER_CONSUMER_NAME,
          messageId,
          payloadHash: inboxPayloadHash,
        },
      });

      // Hook right after DB commit and BEFORE SQS ack (used in crash recovery test)
      if (this.beforeAckHook && receiptHandle) {
        await this.beforeAckHook(messageId, receiptHandle);
      }

      // Commit succeeded -> ACK message from SQS
      if (receiptHandle) {
        await this.sqsService.ackWagerMessage(receiptHandle);
      }

      this.logger.info("SQS wager message processed and acknowledged", {
        correlationId,
        messageId,
        transactionId: result.transactionId,
        walletId: data.walletId,
        providerId: data.providerId,
        status: result.status,
        idempotentReplay: result.idempotentReplay,
      });
    } catch (err: unknown) {
      await this.handleProcessingError(msg, err);
    } finally {
      this.inFlightMessages.delete(sqsMessageId);
    }
  }

  private async handleProcessingError(
    msg: Message,
    err: unknown,
  ): Promise<void> {
    const receiptHandle = msg.ReceiptHandle;
    const receiveCount = Number(
      msg.Attributes?.ApproximateReceiveCount ?? "1",
    );
    const maxReceiveCount = getAppConfig().sqs.maxReceiveCount;

    // Permanent contract/validation/conflict errors -> move immediately to DLQ
    if (
      err instanceof InvalidTransactionInputError ||
      err instanceof InvalidMoneyError ||
      err instanceof IdempotencyConflictError ||
      err instanceof EntityNotFoundError
    ) {
      await this.routeToDlq(msg, err.code);
      return;
    }

    // Transient infrastructure errors -> retry with exponential backoff up to maxReceiveCount, then DLQ
    if (
      err instanceof TransientInfrastructureError ||
      this.isTransientError(err)
    ) {
      if (receiveCount >= maxReceiveCount) {
        await this.routeToDlq(msg, "MAX_RETRIES_EXCEEDED");
        return;
      }

      this.metrics.recordRetry("sqs_transient");
      const backoffSec = Math.min(30, Math.pow(2, receiveCount - 1));
      if (receiptHandle) {
        try {
          await this.sqsService.changeWagerMessageVisibility(
            receiptHandle,
            backoffSec,
          );
        } catch {
          // ignore visibility update errors
        }
      }
      this.logger.warn("Transient error processing SQS message; scheduled retry", {
        messageId: msg.MessageId,
        receiveCount,
        backoffSec,
        error: err instanceof Error ? err.message : String(err),
      });
      return;
    }

    // Simulated crash after commit before ack -> leave message un-acked and return visibility so redelivery happens immediately
    if (err instanceof Error && err.message.includes("SIMULATED_CRASH_BEFORE_ACK")) {
      if (receiptHandle) {
        try {
          await this.sqsService.changeWagerMessageVisibility(receiptHandle, 0);
        } catch {
          // ignore
        }
      }
      throw err;
    }

    // Other unexpected errors: retry up to maxReceiveCount, then DLQ
    if (receiveCount >= maxReceiveCount) {
      await this.routeToDlq(msg, "UNEXPECTED_PERMANENT_ERROR");
      return;
    }

    this.metrics.recordRetry("sqs_transient");
    if (receiptHandle) {
      await this.sqsService.changeWagerMessageVisibility(receiptHandle, 1);
    }
  }

  private async routeToDlq(msg: Message, reason: string): Promise<void> {
    await this.sqsService.sendToDlqAndAck(msg, reason);
    this.metrics.recordDlqMessage();
    this.logger.error("SQS message routed to DLQ", {
      messageId: msg.MessageId,
      reason,
    });
  }

  private isTransientError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const msg = ((err as { message?: string }).message ?? "").toLowerCase();
    return (
      msg.includes("transient") ||
      msg.includes("timeout") ||
      msg.includes("connection") ||
      msg.includes("deadlock") ||
      msg.includes("econnrefused")
    );
  }
}

