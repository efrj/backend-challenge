import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { OutboxMessageRecord } from "../../src/infrastructure/persistence/entities/records";
import {
  assertAllWalletsConsistent,
  createTestAppInstance,
  TestAppInstance,
} from "../helpers/test-app";

describe("Integration — HTTP API, Atomic Financial Flows, Idempotency & Reconciliation", () => {
  let instance: TestAppInstance;
  const createdWalletIds: string[] = [];

  beforeAll(async () => {
    instance = await createTestAppInstance({ workersEnabled: false });
  });

  afterAll(async () => {
    await assertAllWalletsConsistent(instance, createdWalletIds);
    await instance.close();
  });

  it("creates wallet with OPENING transaction and CREDIT ledger entry in the same SQL transaction, and rejects duplicate wallet", async () => {
    const playerId = randomUUID();

    const createRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "1000.00", currency: "BRL" },
      }),
    });

    expect(createRes.status).toBe(201);
    const wallet = (await createRes.json()) as {
      id: string;
      playerId: string;
      balance: { amount: string; currency: string };
      version: number;
    };
    createdWalletIds.push(wallet.id);

    expect(wallet.playerId).toBe(playerId);
    expect(wallet.balance).toEqual({ amount: "1000.00", currency: "BRL" });
    expect(wallet.version).toBe(1);

    // Duplicate wallet for same playerId + currency fails with 409 Conflict
    const dupRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "500.00", currency: "BRL" },
      }),
    });
    expect(dupRes.status).toBe(409);

    // Ledger has the OPENING credit entry
    const ledgerRes = await fetch(
      `${instance.baseUrl}/wallets/${wallet.id}/ledger`,
    );
    expect(ledgerRes.status).toBe(200);
    const ledger = (await ledgerRes.json()) as {
      items: Array<{
        direction: string;
        money: { amount: string; currency: string };
        balanceBefore: { amount: string; currency: string };
        balanceAfter: { amount: string; currency: string };
      }>;
    };
    expect(ledger.items.length).toBe(1);
    expect(ledger.items[0]!.direction).toBe("CREDIT");
    expect(ledger.items[0]!.balanceBefore.amount).toBe("0.00");
    expect(ledger.items[0]!.balanceAfter.amount).toBe("1000.00");
  });

  it("processes BET, WIN, LOSS, REFUND, ROLLBACK atomically with ledger and outbox, and enforces business rules", async () => {
    const playerId = randomUUID();
    const createRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "200.00", currency: "BRL" },
      }),
    });
    const wallet = (await createRes.json()) as { id: string };
    createdWalletIds.push(wallet.id);

    // 1. BET 50.00 -> balance 150.00
    const betExtId = `bet-${randomUUID()}`;
    const betRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `prov-1:${betExtId}`,
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: betExtId,
        playerId,
        walletId: wallet.id,
        roundId: "round-100",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "50.00", currency: "BRL" },
      }),
    });
    expect(betRes.status).toBe(200);
    const betBody = (await betRes.json()) as {
      transactionId: string;
      status: string;
      balance: { amount: string; currency: string };
      idempotentReplay: boolean;
    };
    expect(betBody.status).toBe("PROCESSED");
    expect(betBody.balance).toEqual({ amount: "150.00", currency: "BRL" });
    expect(betBody.idempotentReplay).toBe(false);

    // 2. LOSS -> no balance change, no ledger entry, but WagerTransactionProcessed outbox event created
    const lossExtId = `loss-${randomUUID()}`;
    const lossRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `prov-1:${lossExtId}`,
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: lossExtId,
        playerId,
        walletId: wallet.id,
        roundId: "round-100",
        gameId: "fortune-chimp",
        kind: "LOSS",
        money: { amount: "0.00", currency: "BRL" },
      }),
    });
    expect(lossRes.status).toBe(200);
    const lossBody = (await lossRes.json()) as {
      transactionId: string;
      status: string;
      balance: { amount: string; currency: string };
    };
    expect(lossBody.status).toBe("PROCESSED");
    expect(lossBody.balance.amount).toBe("150.00");

    // Verify LOSS created WagerTransactionProcessed in outbox but NO WalletBalanceChanged
    const fork = instance.em.fork();
    const outboxForLoss = await fork.find(OutboxMessageRecord, {
      aggregateId: wallet.id,
    });
    const lossEvents = outboxForLoss.filter(
      (o) => (o.payload as any)?.causationId === lossBody.transactionId,
    );
    expect(lossEvents.map((e) => e.eventType)).toEqual([
      "WagerTransactionProcessed",
    ]);

    // 3. WIN 80.00 -> balance 230.00
    const winExtId = `win-${randomUUID()}`;
    const winRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `prov-1:${winExtId}`,
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: winExtId,
        playerId,
        walletId: wallet.id,
        roundId: "round-100",
        gameId: "fortune-chimp",
        kind: "WIN",
        money: { amount: "80.00", currency: "BRL" },
        referenceExternalTransactionId: betExtId,
      }),
    });
    expect(winRes.status).toBe(200);
    const winBody = (await winRes.json()) as {
      balance: { amount: string; currency: string };
    };
    expect(winBody.balance.amount).toBe("230.00");

    // 4. REFUND of BET 50.00 -> balance 280.00
    const refundExtId = `refund-${randomUUID()}`;
    const refundRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `prov-1:${refundExtId}`,
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: refundExtId,
        playerId,
        walletId: wallet.id,
        roundId: "round-100",
        gameId: "fortune-chimp",
        kind: "REFUND",
        money: { amount: "50.00", currency: "BRL" },
        referenceExternalTransactionId: betExtId,
      }),
    });
    expect(refundRes.status).toBe(200);
    const refundBody = (await refundRes.json()) as {
      balance: { amount: string; currency: string };
    };
    expect(refundBody.balance.amount).toBe("280.00");

    // 5. Second REFUND of the same BET -> REJECTED with ALREADY_REVERSED (422)
    const dupRefundExtId = `refund-dup-${randomUUID()}`;
    const dupRefundRes = await fetch(
      `${instance.baseUrl}/wagering/transactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `prov-1:${dupRefundExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-1",
          externalTransactionId: dupRefundExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-100",
          gameId: "fortune-chimp",
          kind: "REFUND",
          money: { amount: "50.00", currency: "BRL" },
          referenceExternalTransactionId: betExtId,
        }),
      },
    );
    expect(dupRefundRes.status).toBe(422);
    const dupRefundBody = (await dupRefundRes.json()) as {
      status: string;
      failureCode: string;
      balance: { amount: string };
    };
    expect(dupRefundBody.status).toBe("REJECTED");
    expect(dupRefundBody.failureCode).toBe(FailureCode.AlreadyReversed);
    expect(dupRefundBody.balance.amount).toBe("280.00");

    // 6. ROLLBACK of WIN 80.00 -> DEBIT 80.00 -> balance 200.00
    const rbWinExtId = `rb-win-${randomUUID()}`;
    const rbWinRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `prov-1:${rbWinExtId}`,
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: rbWinExtId,
        playerId,
        walletId: wallet.id,
        roundId: "round-100",
        gameId: "fortune-chimp",
        kind: "ROLLBACK",
        money: { amount: "80.00", currency: "BRL" },
        referenceExternalTransactionId: winExtId,
      }),
    });
    expect(rbWinRes.status).toBe(200);
    const rbWinBody = (await rbWinRes.json()) as {
      balance: { amount: string };
    };
    expect(rbWinBody.balance.amount).toBe("200.00");

    // 7. Spend 180.00 via BET -> balance 20.00, then attempt ROLLBACK of REFUND (50.00) -> REJECTED with REVERSAL_INSUFFICIENT_FUNDS
    const bigBetExtId = `bet-180-${randomUUID()}`;
    await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `prov-1:${bigBetExtId}`,
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: bigBetExtId,
        playerId,
        walletId: wallet.id,
        roundId: "round-100",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "180.00", currency: "BRL" },
      }),
    });

    const rbRefundExtId = `rb-ref-${randomUUID()}`;
    const rbRefundRes = await fetch(
      `${instance.baseUrl}/wagering/transactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `prov-1:${rbRefundExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-1",
          externalTransactionId: rbRefundExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-100",
          gameId: "fortune-chimp",
          kind: "ROLLBACK",
          money: { amount: "50.00", currency: "BRL" },
          referenceExternalTransactionId: refundExtId,
        }),
      },
    );
    expect(rbRefundRes.status).toBe(422);
    const rbRefundBody = (await rbRefundRes.json()) as {
      status: string;
      failureCode: string;
      balance: { amount: string };
    };
    expect(rbRefundBody.status).toBe("REJECTED");
    expect(rbRefundBody.failureCode).toBe(
      FailureCode.ReversalInsufficientFunds,
    );
    expect(rbRefundBody.balance.amount).toBe("20.00");

    // 8. Replay the original first BET (50.00) -> returns original observed balance (150.00) with idempotentReplay: true!
    const replayRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "Idempotency-Key": `prov-1:${betExtId}`,
      },
      body: JSON.stringify({
        providerId: "prov-1",
        externalTransactionId: betExtId,
        playerId,
        walletId: wallet.id,
        roundId: "round-100",
        gameId: "fortune-chimp",
        kind: "BET",
        money: { amount: "50.00", currency: "BRL" },
      }),
    });
    expect(replayRes.status).toBe(200);
    const replayBody = (await replayRes.json()) as {
      transactionId: string;
      status: string;
      balance: { amount: string };
      idempotentReplay: boolean;
    };
    expect(replayBody.transactionId).toBe(betBody.transactionId);
    expect(replayBody.idempotentReplay).toBe(true);
    expect(replayBody.balance.amount).toBe("150.00"); // Original balance observed at the time of bet!

    // 9. Same Idempotency-Key with different payload -> 409 Conflict
    const conflictRes = await fetch(
      `${instance.baseUrl}/wagering/transactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "Idempotency-Key": `prov-1:${betExtId}`,
        },
        body: JSON.stringify({
          providerId: "prov-1",
          externalTransactionId: betExtId,
          playerId,
          walletId: wallet.id,
          roundId: "round-100",
          gameId: "fortune-chimp",
          kind: "BET",
          money: { amount: "55.00", currency: "BRL" }, // different amount!
        }),
      },
    );
    expect(conflictRes.status).toBe(409);

    // 10. Pagination cursor on GET /wallets/:walletId/ledger and Reconciliation endpoint
    const page1Res = await fetch(
      `${instance.baseUrl}/wallets/${wallet.id}/ledger?limit=2`,
    );
    const page1 = (await page1Res.json()) as {
      items: Array<{ id: string }>;
      nextCursor: string | null;
      hasMore: boolean;
    };
    expect(page1.items.length).toBe(2);
    expect(page1.hasMore).toBe(true);
    expect(page1.nextCursor).not.toBeNull();

    const page2Res = await fetch(
      `${instance.baseUrl}/wallets/${wallet.id}/ledger?limit=10&cursor=${encodeURIComponent(page1.nextCursor!)}`,
    );
    const page2 = (await page2Res.json()) as {
      items: Array<{ id: string }>;
      hasMore: boolean;
    };
    expect(page2.items.length).toBe(4);
    expect(page2.hasMore).toBe(false);

    const reconRes = await fetch(
      `${instance.baseUrl}/wallets/${wallet.id}/reconciliation`,
      { method: "POST" },
    );
    expect(reconRes.status).toBe(200);
    const recon = (await reconRes.json()) as {
      consistent: boolean;
      storedBalance: { amount: string };
      calculatedBalance: { amount: string };
      difference: { amount: string };
      checkedEntries: number;
    };
    expect(recon.consistent).toBe(true);
    expect(recon.storedBalance.amount).toBe("20.00");
    expect(recon.calculatedBalance.amount).toBe("20.00");
    expect(recon.difference.amount).toBe("0.00");
    expect(recon.checkedEntries).toBe(6);
  });

  it("exposes health/live, health/ready, and metrics endpoints", async () => {
    const liveRes = await fetch(`${instance.baseUrl}/health/live`);
    expect(liveRes.status).toBe(200);

    const readyRes = await fetch(`${instance.baseUrl}/health/ready`);
    expect(readyRes.status).toBe(200);
    const readyBody = (await readyRes.json()) as {
      status: string;
      checks: { postgres: string; sqs: string };
    };
    expect(readyBody.status).toBe("ready");
    expect(readyBody.checks).toEqual({ postgres: "up", sqs: "up" });

    const metricsRes = await fetch(`${instance.baseUrl}/metrics`);
    expect(metricsRes.status).toBe(200);
    const metricsText = await metricsRes.text();
    expect(metricsText).toContain("wager_transactions_total");
    expect(metricsText).toContain("wager_duplicates_detected_total");
    expect(metricsText).toContain("wager_outbox_lag_seconds");
  });
});

