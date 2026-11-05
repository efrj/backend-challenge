import {
  ChangeMessageVisibilityCommand,
  CreateQueueCommand,
  DeleteMessageCommand,
  GetQueueAttributesCommand,
  GetQueueUrlCommand,
  Message,
  PurgeQueueCommand,
  ReceiveMessageCommand,
  SendMessageCommand,
  SQSClient,
} from "@aws-sdk/client-sqs";
import { Inject, Injectable, OnModuleDestroy, OnModuleInit } from "@nestjs/common";
import { randomUUID } from "crypto";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { StructuredLoggerService } from "../observability/structured-logger.service";

export interface SqsWagerMessageData {
  providerId: string;
  externalTransactionId: string;
  idempotencyKey?: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: {
    amount: string;
    currency: string;
  };
  referenceExternalTransactionId?: string;
}

export interface SqsWagerMessageEnvelope {
  messageId: string;
  type: "WagerTransactionRequested" | string;
  occurredAt: string;
  correlationId?: string;
  data: SqsWagerMessageData;
}

@Injectable()
export class SqsService implements OnModuleInit, OnModuleDestroy {
  private readonly client: SQSClient;
  readonly wagerQueueName: string;
  readonly wagerDlqName: string;
  readonly eventsQueueName: string;

  private wagerQueueUrl?: string;
  private wagerDlqUrl?: string;
  private eventsQueueUrl?: string;

  constructor(
    @Inject(StructuredLoggerService)
    private readonly logger: StructuredLoggerService,
  ) {
    this.wagerQueueName =
      process.env.SQS_WAGER_QUEUE_NAME ?? "wager-transactions.fifo";
    this.wagerDlqName =
      process.env.SQS_WAGER_DLQ_NAME ?? "wager-transactions-dlq.fifo";
    this.eventsQueueName =
      process.env.SQS_EVENTS_QUEUE_NAME ?? "wager-integration-events.fifo";

    this.client = new SQSClient({
      region: process.env.AWS_REGION ?? "us-east-1",
      endpoint: process.env.SQS_ENDPOINT ?? "http://localhost:4566",
      credentials: {
        accessKeyId: process.env.AWS_ACCESS_KEY_ID ?? "test",
        secretAccessKey: process.env.AWS_SECRET_ACCESS_KEY ?? "test",
      },
    });
  }

  async onModuleInit(): Promise<void> {
    await this.ensureQueuesExist();
  }

  onModuleDestroy(): void {
    this.client.destroy();
  }

  async ensureQueuesExist(): Promise<void> {
    // Always ensure the canonical challenge queues exist in LocalStack
    if (this.wagerDlqName !== "wager-transactions-dlq.fifo") {
      const canonicalDlqUrl = await this.getOrCreateQueue(
        "wager-transactions-dlq.fifo",
        {
          FifoQueue: "true",
          ContentBasedDeduplication: "false",
        },
      );
      const canonicalDlqAttrs = await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: canonicalDlqUrl,
          AttributeNames: ["QueueArn"],
        }),
      );
      const canonicalDlqArn = canonicalDlqAttrs.Attributes?.QueueArn;
      await this.getOrCreateQueue("wager-transactions.fifo", {
        FifoQueue: "true",
        ContentBasedDeduplication: "false",
        VisibilityTimeout: "30",
        ...(canonicalDlqArn
          ? {
              RedrivePolicy: JSON.stringify({
                deadLetterTargetArn: canonicalDlqArn,
                maxReceiveCount: "3",
              }),
            }
          : {}),
      });
    }

    // 1. DLQ FIFO
    this.wagerDlqUrl = await this.getOrCreateQueue(this.wagerDlqName, {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
    });

    const dlqAttrs = await this.client.send(
      new GetQueueAttributesCommand({
        QueueUrl: this.wagerDlqUrl,
        AttributeNames: ["QueueArn"],
      }),
    );
    const dlqArn = dlqAttrs.Attributes?.QueueArn;

    // 2. Main Wager Transactions FIFO Queue with RedrivePolicy to DLQ
    const maxReceiveCount = process.env.SQS_MAX_RECEIVE_COUNT ?? "3";
    const mainAttrs: Record<string, string> = {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
      VisibilityTimeout: process.env.SQS_VISIBILITY_TIMEOUT_SEC ?? "30",
    };
    if (dlqArn) {
      mainAttrs.RedrivePolicy = JSON.stringify({
        deadLetterTargetArn: dlqArn,
        maxReceiveCount: String(maxReceiveCount),
      });
    }

    this.wagerQueueUrl = await this.getOrCreateQueue(
      this.wagerQueueName,
      mainAttrs,
    );

    // 3. Integration Events FIFO Queue (target for Transactional Outbox publisher)
    this.eventsQueueUrl = await this.getOrCreateQueue(this.eventsQueueName, {
      FifoQueue: "true",
      ContentBasedDeduplication: "false",
    });
  }

  private async getOrCreateQueue(
    queueName: string,
    attributes: Record<string, string>,
  ): Promise<string> {
    try {
      const existing = await this.client.send(
        new GetQueueUrlCommand({ QueueName: queueName }),
      );
      if (existing.QueueUrl) {
        return existing.QueueUrl;
      }
    } catch {
      // Queue does not exist yet; create it
    }

    const created = await this.client.send(
      new CreateQueueCommand({
        QueueName: queueName,
        Attributes: attributes,
      }),
    );

    if (!created.QueueUrl) {
      throw new Error(`Failed to resolve QueueUrl for '${queueName}'`);
    }
    return created.QueueUrl;
  }

  async getWagerQueueUrl(): Promise<string> {
    if (!this.wagerQueueUrl) {
      await this.ensureQueuesExist();
    }
    return this.wagerQueueUrl!;
  }

  async getWagerDlqUrl(): Promise<string> {
    if (!this.wagerDlqUrl) {
      await this.ensureQueuesExist();
    }
    return this.wagerDlqUrl!;
  }

  async getEventsQueueUrl(): Promise<string> {
    if (!this.eventsQueueUrl) {
      await this.ensureQueuesExist();
    }
    return this.eventsQueueUrl!;
  }

  async publishOutboxEvent(outbox: OutboxMessage): Promise<void> {
    const queueUrl = await this.getEventsQueueUrl();
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: JSON.stringify(outbox.payload),
        MessageGroupId: outbox.aggregateId || "default-group",
        MessageDeduplicationId: outbox.id,
        MessageAttributes: {
          eventType: {
            DataType: "String",
            StringValue: outbox.eventType,
          },
        },
      }),
    );
  }

  async sendWagerMessage(
    envelope: SqsWagerMessageEnvelope | Record<string, unknown> | string,
    options?: {
      messageGroupId?: string;
      messageDeduplicationId?: string;
    },
  ): Promise<string> {
    const queueUrl = await this.getWagerQueueUrl();
    const body =
      typeof envelope === "string" ? envelope : JSON.stringify(envelope);

    const parsed =
      typeof envelope === "object" && envelope !== null
        ? (envelope as Partial<SqsWagerMessageEnvelope>)
        : undefined;

    const groupId =
      options?.messageGroupId ??
      parsed?.data?.walletId ??
      "default-wallet-group";
    const deduplicationId =
      options?.messageDeduplicationId ??
      `${parsed?.messageId ?? randomUUID()}-${randomUUID()}`;

    const res = await this.client.send(
      new SendMessageCommand({
        QueueUrl: queueUrl,
        MessageBody: body,
        MessageGroupId: groupId,
        MessageDeduplicationId: deduplicationId,
      }),
    );

    return res.MessageId ?? "";
  }

  async receiveWagerMessages(
    maxMessages = 10,
    waitTimeSeconds = 1,
    visibilityTimeout?: number,
  ): Promise<Message[]> {
    const queueUrl = await this.getWagerQueueUrl();
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: queueUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
        VisibilityTimeout: visibilityTimeout,
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      }),
    );
    return res.Messages ?? [];
  }

  async ackWagerMessage(receiptHandle: string): Promise<void> {
    const queueUrl = await this.getWagerQueueUrl();
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async changeWagerMessageVisibility(
    receiptHandle: string,
    visibilityTimeoutSeconds: number,
  ): Promise<void> {
    const queueUrl = await this.getWagerQueueUrl();
    await this.client.send(
      new ChangeMessageVisibilityCommand({
        QueueUrl: queueUrl,
        ReceiptHandle: receiptHandle,
        VisibilityTimeout: Math.max(0, Math.floor(visibilityTimeoutSeconds)),
      }),
    );
  }

  async sendToDlqAndAck(
    sourceMessage: Message,
    reason: string,
    messageGroupId = "dlq-group",
  ): Promise<void> {
    const dlqUrl = await this.getWagerDlqUrl();
    const dedupId = `${sourceMessage.MessageId ?? randomUUID()}-dlq`;
    await this.client.send(
      new SendMessageCommand({
        QueueUrl: dlqUrl,
        MessageBody: sourceMessage.Body ?? "{}",
        MessageGroupId: messageGroupId,
        MessageDeduplicationId: dedupId,
        MessageAttributes: {
          dlqReason: {
            DataType: "String",
            StringValue: reason,
          },
          originalMessageId: {
            DataType: "String",
            StringValue: sourceMessage.MessageId ?? "unknown",
          },
        },
      }),
    );

    if (sourceMessage.ReceiptHandle) {
      await this.ackWagerMessage(sourceMessage.ReceiptHandle);
    }
  }

  async receiveDlqMessages(
    maxMessages = 10,
    waitTimeSeconds = 0,
  ): Promise<Message[]> {
    const dlqUrl = await this.getWagerDlqUrl();
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: dlqUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      }),
    );
    return res.Messages ?? [];
  }

  async receivePublishedEventMessages(
    maxMessages = 10,
    waitTimeSeconds = 0,
  ): Promise<Message[]> {
    const eventsUrl = await this.getEventsQueueUrl();
    const res = await this.client.send(
      new ReceiveMessageCommand({
        QueueUrl: eventsUrl,
        MaxNumberOfMessages: maxMessages,
        WaitTimeSeconds: waitTimeSeconds,
        AttributeNames: ["All"],
        MessageAttributeNames: ["All"],
      }),
    );
    return res.Messages ?? [];
  }

  async ackEventMessage(receiptHandle: string): Promise<void> {
    const eventsUrl = await this.getEventsQueueUrl();
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: eventsUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async ackDlqMessage(receiptHandle: string): Promise<void> {
    const dlqUrl = await this.getWagerDlqUrl();
    await this.client.send(
      new DeleteMessageCommand({
        QueueUrl: dlqUrl,
        ReceiptHandle: receiptHandle,
      }),
    );
  }

  async purgeQueue(queueUrl: string): Promise<void> {
    try {
      await this.client.send(new PurgeQueueCommand({ QueueUrl: queueUrl }));
    } catch {
      // Fallback: drain messages in a loop if PurgeQueue is throttled
      for (let i = 0; i < 10; i++) {
        const res = await this.client.send(
          new ReceiveMessageCommand({
            QueueUrl: queueUrl,
            MaxNumberOfMessages: 10,
            WaitTimeSeconds: 0,
          }),
        );
        if (!res.Messages || res.Messages.length === 0) break;
        for (const msg of res.Messages) {
          if (msg.ReceiptHandle) {
            await this.client.send(
              new DeleteMessageCommand({
                QueueUrl: queueUrl,
                ReceiptHandle: msg.ReceiptHandle,
              }),
            );
          }
        }
      }
    }
  }

  async isHealthy(): Promise<boolean> {
    try {
      const url = await this.getWagerQueueUrl();
      await this.client.send(
        new GetQueueAttributesCommand({
          QueueUrl: url,
          AttributeNames: ["ApproximateNumberOfMessages"],
        }),
      );
      return true;
    } catch (err) {
      this.logger.warn("SQS health check failed", {
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }
}
