import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { TransientInfrastructureError } from "../../src/domain/errors/domain-errors";
import {
  InboxMessageRecord,
  OutboxMessageRecord,
  WagerTransactionRecord,
} from "../../src/infrastructure/persistence/entities/records";
import {
  assertAllWalletsConsistent,
  createTestAppInstance,
  TestAppInstance,
} from "../helpers/test-app";

describe("Integration — SQS Consumer, Persistent Inbox, Outbox Publisher, Retry & DLQ", () => {
  let instance: TestAppInstance;
  const createdWalletIds: string[] = [];

  beforeAll(async () => {
    instance = await createTestAppInstance({ workersEnabled: false });
    await instance.sqsService.purgeQueue(
      await instance.sqsService.getWagerQueueUrl(),
    );
    await instance.sqsService.purgeQueue(
      await instance.sqsService.getWagerDlqUrl(),
    );
    await instance.sqsService.purgeQueue(
      await instance.sqsService.getEventsQueueUrl(),
    );
  });

  afterAll(async () => {
    await assertAllWalletsConsistent(instance, createdWalletIds);
    await instance.close();
  });

  it("processes SQS wager messages, records persistent inbox, deduplicates redeliveries, and publishes outbox events", async () => {
    const playerId = randomUUID();
    const createRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "500.00", currency: "BRL" },
      }),
    });
    const wallet = (await createRes.json()) as { id: string };
    createdWalletIds.push(wallet.id);

    const msgId = `msg-${randomUUID()}`;
    const extTxId = `sqs-bet-${randomUUID()}`;
    const envelope = {
      messageId: msgId,
      type: "WagerTransactionRequested",
      occurredAt: new Date().toISOString(),
      data: {
        providerId: "provider-sqs",
        externalTransactionId: extTxId,
        idempotencyKey: `provider-sqs:${extTxId}`,
        playerId,
        walletId: wallet.id,
        roundId: "round-sqs-1",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "75.00", currency: "BRL" },
      },
    };

    // Send first delivery and a duplicate redelivery of the exact same messageId
    await instance.sqsService.sendWagerMessage(envelope, {
      messageGroupId: wallet.id,
      messageDeduplicationId: `${msgId}-delivery-1`,
    });
    await instance.sqsService.sendWagerMessage(envelope, {
      messageGroupId: wallet.id,
      messageDeduplicationId: `${msgId}-delivery-2`,
    });

    await instance.sqsConsumerWorker.pollOnce(10, 1);
    await instance.sqsConsumerWorker.pollOnce(10, 0);

    // Check wallet balance was debited only ONCE (500 - 75 = 425)
    const getWalletRes = await fetch(`${instance.baseUrl}/wallets/${wallet.id}`);
    const walletState = (await getWalletRes.json()) as {
      balance: { amount: string };
      version: number;
    };
    expect(walletState.balance.amount).toBe("425.00");
    expect(walletState.version).toBe(2);

    // Check persistent inbox record exists and is marked processed
    const fork = instance.em.fork();
    const inboxRecord = await fork.findOne(InboxMessageRecord, {
      messageId: msgId,
    });
    expect(inboxRecord).not.toBeNull();
    expect(inboxRecord!.processedAt).not.toBeNull();

    // Run OutboxPublisherWorker and verify events are published and marked publishedAt
    const published = await instance.outboxWorker.publishBatch(50);
    expect(published).toBeGreaterThanOrEqual(2);

    const remainingPending = await fork.count(OutboxMessageRecord, {
      aggregateId: wallet.id,
      publishedAt: null,
    });
    expect(remainingPending).toBe(0);
  });

  it("retries transient SQS errors and routes poison/exhausted messages to wager-transactions-dlq.fifo", async () => {
    const playerId = randomUUID();
    const createRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    const wallet = (await createRes.json()) as { id: string };
    createdWalletIds.push(wallet.id);

    // 1. Send malformed poison message -> immediately routed to DLQ
    await instance.sqsService.sendWagerMessage("{ invalid-json-payload", {
      messageGroupId: `dlq-test-${randomUUID()}`,
      messageDeduplicationId: `poison-${randomUUID()}`,
    });

    await instance.sqsConsumerWorker.pollOnce(10, 1);

    const dlqMessages = await instance.sqsService.receiveDlqMessages(10, 1);
    expect(dlqMessages.length).toBeGreaterThanOrEqual(1);
    for (const m of dlqMessages) {
      if (m.ReceiptHandle) {
        await instance.sqsService.ackDlqMessage(m.ReceiptHandle);
      }
    }

    // 2. Simulate a transient error on the first attempt that succeeds on retry
    const retryMsgId = `msg-retry-${randomUUID()}`;
    const retryExtTxId = `tx-retry-${randomUUID()}`;
    let attemptsForMsg = 0;

    instance.sqsConsumerWorker.beforeProcessHook = async (messageId) => {
      if (messageId === retryMsgId) {
        attemptsForMsg += 1;
        if (attemptsForMsg === 1) {
          throw new TransientInfrastructureError("Simulated transient DB glitch");
        }
      }
    };

    try {
      await instance.sqsService.sendWagerMessage(
        {
          messageId: retryMsgId,
          type: "WagerTransactionRequested",
          occurredAt: new Date().toISOString(),
          data: {
            providerId: "provider-sqs",
            externalTransactionId: retryExtTxId,
            idempotencyKey: `provider-sqs:${retryExtTxId}`,
            playerId,
            walletId: wallet.id,
            roundId: "round-retry",
            gameId: "fortune-chimp",
            kind: "BET",
            money: { amount: "30.00", currency: "BRL" },
          },
        },
        {
          messageGroupId: `retry-group-${randomUUID()}`,
          messageDeduplicationId: retryMsgId,
        },
      );

      // First poll triggers transient failure and sets 1s backoff visibility timeout
      await instance.sqsConsumerWorker.pollOnce(10, 1);
      expect(attemptsForMsg).toBe(1);

      // Wait for 1.2s visibility timeout to expire, then poll again -> succeeds!
      await new Promise((r) => setTimeout(r, 1250));
      await instance.sqsConsumerWorker.pollOnce(10, 1);
      expect(attemptsForMsg).toBe(2);

      const txRecord = await instance.em
        .fork()
        .findOne(WagerTransactionRecord, {
          providerId: "provider-sqs",
          externalTransactionId: retryExtTxId,
        });
      expect(txRecord).not.toBeNull();
      expect(txRecord!.status).toBe("PROCESSED");
    } finally {
      instance.sqsConsumerWorker.beforeProcessHook = undefined;
    }
  });
});

