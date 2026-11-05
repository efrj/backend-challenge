import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { LedgerDirection } from "../../src/domain/wallet/wallet-ledger-entry";
import {
  OutboxMessageRecord,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
} from "../../src/infrastructure/persistence/entities/records";
import {
  assertAllWalletsConsistent,
  createTestAppInstance,
  TestAppInstance,
} from "../helpers/test-app";

describe("Concurrency & Resilience Suite (Real Parallelism across >= 3 Instances)", () => {
  let instances: [TestAppInstance, TestAppInstance, TestAppInstance];
  const trackedWallets: string[] = [];

  beforeAll(async () => {
    const i1 = await createTestAppInstance({
      workersEnabled: false,
      instanceId: "node-1",
    });
    const i2 = await createTestAppInstance({
      workersEnabled: false,
      instanceId: "node-2",
    });
    const i3 = await createTestAppInstance({
      workersEnabled: false,
      instanceId: "node-3",
    });
    instances = [i1, i2, i3];

    await i1.sqsService.purgeQueue(await i1.sqsService.getWagerQueueUrl());
    await i1.sqsService.purgeQueue(await i1.sqsService.getWagerDlqUrl());
    await i1.sqsService.purgeQueue(await i1.sqsService.getEventsQueueUrl());
  });

  afterAll(async () => {
    // Global Final Invariant across all tests: wallet.balance == reconstructed ledger balance
    await assertAllWalletsConsistent(instances[0], trackedWallets);
    await Promise.all(instances.map((inst) => inst.close()));
  });

  it("Scenario 1: Same bet sent 50 times in parallel across 3 instances -> single debit", async () => {
    const playerId = randomUUID();
    const createRes = await fetch(`${instances[0].baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "500.00", currency: "BRL" },
      }),
    });
    const wallet = (await createRes.json()) as { id: string };
    trackedWallets.push(wallet.id);

    const extTxId = `bet-50x-${randomUUID()}`;
    const idempotencyKey = `provider-a:${extTxId}`;
    const payload = {
      providerId: "provider-a",
      externalTransactionId: extTxId,
      playerId,
      walletId: wallet.id,
      roundId: "round-50x",
      gameId: "fortune-chimp",
      kind: "BET",
      money: { amount: "25.00", currency: "BRL" },
    };

    const requests = Array.from({ length: 50 }, (_, idx) => {
      const targetInstance = instances[idx % instances.length]!;
      return fetch(`${targetInstance.baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": idempotencyKey,
        },
        body: JSON.stringify(payload),
      }).then(async (res) => ({
        status: res.status,
        body: (await res.json()) as {
          transactionId: string;
          status: string;
          balance: { amount: string; currency: string };
          idempotentReplay: boolean;
        },
      }));
    });

    const responses = await Promise.all(requests);

    // Every single one of the 50 parallel responses must succeed with 200 OK and identical balance 475.00
    for (const r of responses) {
      expect(r.status).toBe(200);
      expect(r.body.status).toBe("PROCESSED");
      expect(r.body.balance).toEqual({ amount: "475.00", currency: "BRL" });
    }

    const uniqueTxIds = new Set(responses.map((r) => r.body.transactionId));
    expect(uniqueTxIds.size).toBe(1);

    const firstProcesses = responses.filter((r) => !r.body.idempotentReplay);
    const replays = responses.filter((r) => r.body.idempotentReplay);
    expect(firstProcesses.length).toBe(1);
    expect(replays.length).toBe(49);

    // Verify only 1 DEBIT entry exists in the ledger
    const fork = instances[0].em.fork();
    const debitEntries = await fork.find(WalletLedgerEntryRecord, {
      walletId: wallet.id,
      direction: LedgerDirection.Debit,
    });
    expect(debitEntries.length).toBe(1);
    expect(debitEntries[0]!.moneyAmount).toBe("25.00");

    // Verify reconciliation invariant
    const recon = await instances[0].reconcileUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe("475.00");
  });

  it("Scenario 2 (Section 8 Mandatory): Initial balance 100.00 BRL, two simultaneous 80.00 BRL bets -> 1 PROCESSED, 1 REJECTED, final balance 20.00 BRL, 1 DEBIT ledger entry", async () => {
    const playerId = randomUUID();
    const createRes = await fetch(`${instances[0].baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    const wallet = (await createRes.json()) as { id: string };
    trackedWallets.push(wallet.id);

    const bet1ExtId = `bet-80-a-${randomUUID()}`;
    const bet2ExtId = `bet-80-b-${randomUUID()}`;

    const [res1, res2] = await Promise.all([
      fetch(`${instances[0].baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `prov-race:${bet1ExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-race",
          externalTransactionId: bet1ExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-80",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        }),
      }).then(async (r) => ({ statusHttp: r.status, body: await r.json() as any })),
      fetch(`${instances[1].baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `prov-race:${bet2ExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-race",
          externalTransactionId: bet2ExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-80",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        }),
      }).then(async (r) => ({ statusHttp: r.status, body: await r.json() as any })),
    ]);

    const results = [res1, res2];
    const processed = results.filter((r) => r.body.status === "PROCESSED");
    const rejected = results.filter((r) => r.body.status === "REJECTED");

    expect(processed.length).toBe(1);
    expect(rejected.length).toBe(1);
    expect(processed[0]!.statusHttp).toBe(200);
    expect(processed[0]!.body.balance.amount).toBe("20.00");

    expect(rejected[0]!.statusHttp).toBe(422);
    expect(rejected[0]!.body.failureCode).toBe(FailureCode.InsufficientFunds);

    // Retry both -> neither retry duplicates the debit
    const [retry1, retry2] = await Promise.all([
      fetch(`${instances[2].baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `prov-race:${bet1ExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-race",
          externalTransactionId: bet1ExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-80",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        }),
      }).then(async (r) => r.json() as Promise<any>),
      fetch(`${instances[2].baseUrl}/wagering/transactions`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `prov-race:${bet2ExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-race",
          externalTransactionId: bet2ExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-80",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "80.00", currency: "BRL" },
        }),
      }).then(async (r) => r.json() as Promise<any>),
    ]);

    expect(retry1.idempotentReplay).toBe(true);
    expect(retry2.idempotentReplay).toBe(true);

    // Verify final balance is 20.00 BRL and exactly 1 DEBIT entry exists in ledger
    const fork = instances[0].em.fork();
    const debitEntries = await fork.find(WalletLedgerEntryRecord, {
      walletId: wallet.id,
      direction: LedgerDirection.Debit,
    });
    expect(debitEntries.length).toBe(1);

    const recon = await instances[0].reconcileUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe("20.00");
    expect(recon.calculatedBalance.amount).toBe("20.00");
  });

  it("Scenario 3 & 4: Distinct wallets and hot wallet processed in parallel across >= 3 simultaneous instances", async () => {
    // Create 12 distinct wallets in parallel across the 3 instances, each with 100.00 BRL
    const wallets = await Promise.all(
      Array.from({ length: 12 }, async (_, idx) => {
        const inst = instances[idx % instances.length]!;
        const res = await fetch(`${inst.baseUrl}/wallets`, {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            playerId: randomUUID(),
            initialBalance: { amount: "100.00", currency: "BRL" },
          }),
        });
        const w = (await res.json()) as { id: string; playerId: string };
        trackedWallets.push(w.id);
        return w;
      }),
    );

    // On each of the 12 wallets, fire 4 concurrent operations (3 BETs of 40.00 and 1 WIN of 15.00) across the 3 instances
    await Promise.all(
      wallets.flatMap((w, wIdx) => {
        const ops = [
          { kind: "BET", amount: "40.00", ext: `b1-${w.id}` },
          { kind: "BET", amount: "40.00", ext: `b2-${w.id}` },
          { kind: "BET", amount: "40.00", ext: `b3-${w.id}` },
          { kind: "WIN", amount: "15.00", ext: `w1-${w.id}` },
        ];
        return ops.map((op, opIdx) => {
          const inst = instances[(wIdx + opIdx) % instances.length]!;
          return fetch(`${inst.baseUrl}/wagering/transactions`, {
            method: "POST",
            headers: {
              "content-type": "application/json",
              "Idempotency-Key": `prov-multi:${op.ext}`,
            },
            body: JSON.stringify({
              providerId: "prov-multi",
              externalTransactionId: op.ext,
              playerId: w.playerId,
              walletId: w.id,
              roundId: `round-${w.id}`,
              gameId: "fortune-chimp",
              kind: op.kind,
              money: { amount: op.amount, currency: "BRL" },
            }),
          });
        });
      }),
    );

    // Every single wallet must be 100% consistent with its ledger and non-negative!
    for (const w of wallets) {
      const recon = await instances[0].reconcileUseCase.execute(w.id);
      expect(recon.consistent).toBe(true);
      expect(Number(recon.storedBalance.amount)).toBeGreaterThanOrEqual(0);
    }
  });

  it("Scenario 5: Worker killed AFTER SQL commit and BEFORE SQS ack -> redelivery does not duplicate financial effects", async () => {
    const playerId = randomUUID();
    const createRes = await fetch(`${instances[0].baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "300.00", currency: "BRL" },
      }),
    });
    const wallet = (await createRes.json()) as { id: string };
    trackedWallets.push(wallet.id);

    const crashMsgId = `msg-crash-${randomUUID()}`;
    const crashExtId = `tx-crash-${randomUUID()}`;

    await instances[0].sqsService.sendWagerMessage(
      {
        messageId: crashMsgId,
        type: "WagerTransactionRequested",
        occurredAt: new Date().toISOString(),
        data: {
          providerId: "prov-crash",
          externalTransactionId: crashExtId,
          idempotencyKey: `prov-crash:${crashExtId}`,
          playerId,
          walletId: wallet.id,
          roundId: "round-crash",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "60.00", currency: "BRL" },
        },
      },
      {
        messageGroupId: `crash-group-${wallet.id}`,
        messageDeduplicationId: crashMsgId,
      },
    );

    // Configure Instance 1's consumer to crash right after DB commit and BEFORE SQS ack
    let crashedOnce = false;
    instances[0].sqsConsumerWorker.beforeAckHook = async (messageId) => {
      if (messageId === crashMsgId && !crashedOnce) {
        crashedOnce = true;
        throw new Error("SIMULATED_CRASH_BEFORE_ACK");
      }
    };

    try {
      await expect(
        instances[0].sqsConsumerWorker.pollOnce(10, 1),
      ).rejects.toThrow("SIMULATED_CRASH_BEFORE_ACK");
    } finally {
      instances[0].sqsConsumerWorker.beforeAckHook = undefined;
    }

    expect(crashedOnce).toBe(true);

    // Instance 2 now polls the un-acked redelivered message from SQS and processes it cleanly
    await instances[1].sqsConsumerWorker.pollOnce(10, 1);

    // Balance must be debited only ONCE (300 - 60 = 240.00)
    const recon = await instances[1].reconcileUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe("240.00");
    expect(recon.checkedEntries).toBe(2); // 1 OPENING + 1 BET
  });

  it("Scenario 6: Two concurrent publishers over the same outbox -> all events published without loss or conflict", async () => {
    const fork = instances[0].em.fork();
    const pendingBefore = await fork.count(OutboxMessageRecord, {
      publishedAt: null,
    });
    expect(pendingBefore).toBeGreaterThan(0);

    const publishedIds: string[] = [];
    const customPublish = async (msg: { id: string }) => {
      await new Promise((r) => setTimeout(r, 5));
      publishedIds.push(msg.id);
    };

    // Run Publisher 1 and Publisher 2 concurrently in parallel batches until outbox is drained
    for (let round = 0; round < 5; round++) {
      const [c1, c2] = await Promise.all([
        instances[0].outboxWorker.publishBatch(15, customPublish),
        instances[1].outboxWorker.publishBatch(15, customPublish),
      ]);
      if (c1 === 0 && c2 === 0) break;
    }

    const pendingAfter = await fork.count(OutboxMessageRecord, {
      publishedAt: null,
    });
    expect(pendingAfter).toBe(0);

    // Verify FOR UPDATE SKIP LOCKED prevented both publishers from claiming the same row simultaneously
    const uniquePublishedIds = new Set(publishedIds);
    expect(uniquePublishedIds.size).toBe(publishedIds.length);
  });

  it("Scenario 7: Out-of-order delivery — REFUND and ROLLBACK delivered BEFORE the referenced BET", async () => {
    const playerId = randomUUID();
    const createRes = await fetch(`${instances[0].baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "200.00", currency: "BRL" },
      }),
    });
    const wallet = (await createRes.json()) as { id: string };
    trackedWallets.push(wallet.id);

    const lateBetExtId = `late-bet-${randomUUID()}`;
    const earlyRefundExtId = `early-refund-${randomUUID()}`;

    // 1. Submit REFUND first (before late-bet exists!) -> 202 Accepted (PENDING_REFERENCE)
    const refundRes = await fetch(
      `${instances[0].baseUrl}/wagering/transactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `prov-ooo:${earlyRefundExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-ooo",
          externalTransactionId: earlyRefundExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-ooo",
          gameId: "fortune-chimp",
          kind: "REFUND",
          money: { amount: "45.00", currency: "BRL" },
          referenceExternalTransactionId: lateBetExtId,
        }),
      },
    );
    expect(refundRes.status).toBe(202);
    const refundBody = (await refundRes.json()) as {
      transactionId: string;
      status: string;
      balance: { amount: string };
    };
    expect(refundBody.status).toBe("PENDING_REFERENCE");
    expect(refundBody.balance.amount).toBe("200.00");

    // 2. Now the referenced BET arrives -> 200 OK (PROCESSED), balance becomes 155.00
    const betRes = await fetch(
      `${instances[1].baseUrl}/wagering/transactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `prov-ooo:${lateBetExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-ooo",
          externalTransactionId: lateBetExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-ooo",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "45.00", currency: "BRL" },
        }),
      },
    );
    expect(betRes.status).toBe(200);
    const betBody = (await betRes.json()) as { balance: { amount: string } };
    expect(betBody.balance.amount).toBe("155.00");

    // 3. Wait 250ms for nextRetryAt and run PendingReferenceWorker -> resolves REFUND to PROCESSED, balance restored to 200.00!
    await new Promise((r) => setTimeout(r, 250));
    await instances[2].pendingRefWorker.processDuePendingReferences(20);

    const getRefundRes = await fetch(
      `${instances[0].baseUrl}/wagering/transactions/${refundBody.transactionId}`,
    );
    const resolvedRefund = (await getRefundRes.json()) as {
      status: string;
      balance: { amount: string };
    };
    expect(resolvedRefund.status).toBe("PROCESSED");
    expect(resolvedRefund.balance.amount).toBe("200.00");

    // 4. Also test orphan ROLLBACK whose reference NEVER arrives -> transitions to REJECTED (REFERENCE_NOT_FOUND) after maxAttempts
    const orphanRollbackExtId = `orphan-rb-${randomUUID()}`;
    const orphanRes = await fetch(
      `${instances[0].baseUrl}/wagering/transactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `prov-ooo:${orphanRollbackExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-ooo",
          externalTransactionId: orphanRollbackExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-ooo",
          gameId: "fortune-chimp",
          kind: "ROLLBACK",
          money: { amount: "10.00", currency: "BRL" },
          referenceExternalTransactionId: "non-existent-bet-id",
        }),
      },
    );
    expect(orphanRes.status).toBe(202);
    const orphanBody = (await orphanRes.json()) as { transactionId: string };

    // Exhaust 2 retry attempts with 1ms base delay
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 220));
      await instances[0].pendingRefWorker.processDuePendingReferences(20, 2, 1);
    }

    const orphanFinalRes = await fetch(
      `${instances[0].baseUrl}/wagering/transactions/${orphanBody.transactionId}`,
    );
    const orphanFinal = (await orphanFinalRes.json()) as {
      status: string;
      failureCode: string;
    };
    expect(orphanFinal.status).toBe("REJECTED");
    expect(orphanFinal.failureCode).toBe(FailureCode.ReferenceNotFound);
  });

  it("Scenario 8: Service restart recovery and final consistency verification across all wallets", async () => {
    const playerId = randomUUID();
    const createRes = await fetch(`${instances[2].baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "150.00", currency: "BRL" },
      }),
    });
    const wallet = (await createRes.json()) as { id: string };
    trackedWallets.push(wallet.id);

    // Submit a ROLLBACK before its BET on instance[2], then shut down instance[2] completely!
    const betExtId = `restart-bet-${randomUUID()}`;
    const rbExtId = `restart-rb-${randomUUID()}`;

    const rbRes = await fetch(`${instances[2].baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `prov-restart:${rbExtId}`,
      },
      body: JSON.stringify({
        providerId: "prov-restart",
        externalTransactionId: rbExtId,
        playerId,
        walletId: wallet.id,
        roundId: "round-restart",
        gameId: "fortune-chimp",
        kind: "ROLLBACK",
        money: { amount: "40.00", currency: "BRL" },
        referenceExternalTransactionId: betExtId,
      }),
    });
    expect(rbRes.status).toBe(202);

    // Shut down instance[2] and boot a fresh replacement instance
    await instances[2].close();
    instances[2] = await createTestAppInstance({
      workersEnabled: false,
      instanceId: "node-3-restarted",
    });

    // Submit the referenced BET on the restarted instance
    const betRes = await fetch(`${instances[2].baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `prov-restart:${betExtId}`,
      },
      body: JSON.stringify({
        providerId: "prov-restart",
        externalTransactionId: betExtId,
        playerId,
        walletId: wallet.id,
        roundId: "round-restart",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "40.00", currency: "BRL" },
      }),
    });
    expect(betRes.status).toBe(200);

    // Run pending reference worker and outbox publisher on the restarted instance
    await new Promise((r) => setTimeout(r, 250));
    await instances[2].pendingRefWorker.processDuePendingReferences(20);
    await instances[2].outboxWorker.publishBatch(100);

    const recon = await instances[2].reconcileUseCase.execute(wallet.id);
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe("150.00");
    expect(recon.calculatedBalance.amount).toBe("150.00");
    expect(recon.checkedEntries).toBe(3); // OPENING (+150), BET (-40), ROLLBACK (+40)
  });
});

