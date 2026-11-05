import { describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import {
  InvalidTransactionInputError,
  InvalidTransactionStateError,
} from "../../src/domain/errors/domain-errors";
import { WalletBalanceChanged } from "../../src/domain/events/wallet-balance-changed.event";
import { InboxMessage } from "../../src/domain/messaging/inbox-message";
import { OutboxMessage } from "../../src/domain/messaging/outbox-message";
import { Money } from "../../src/domain/money/money";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { computeWagerPayloadHash } from "../../src/domain/wagering/payload-hash";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../src/domain/wagering/wager-transaction";
import { Wallet } from "../../src/domain/wallet/wallet";
import { LedgerDirection } from "../../src/domain/wallet/wallet-ledger-entry";

describe("WagerTransaction, PayloadHash & Messaging Domain Rules", () => {
  const baseProps = () => {
    const walletId = randomUUID();
    const playerId = randomUUID();
    const money = Money.from({ amount: "25.00", currency: "BRL" });
    const payloadHash = computeWagerPayloadHash({
      providerId: "provider-a",
      externalTransactionId: "tx-1",
      playerId,
      walletId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Bet,
      money: money.toJSON(),
    });
    return {
      id: randomUUID(),
      providerId: "provider-a",
      externalTransactionId: "tx-1",
      idempotencyKey: "provider-a:tx-1",
      payloadHash,
      walletId,
      playerId,
      roundId: "round-1",
      gameId: "fortune-chimp",
      kind: WagerTransactionKind.Bet,
      money,
    };
  };

  it("enforces referenceExternalTransactionId for REFUND and ROLLBACK on creation", () => {
    const props = baseProps();

    expect(() =>
      WagerTransaction.create({
        ...props,
        kind: WagerTransactionKind.Refund,
        referenceExternalTransactionId: undefined,
      }),
    ).toThrow(InvalidTransactionInputError);

    expect(() =>
      WagerTransaction.create({
        ...props,
        kind: WagerTransactionKind.Rollback,
        referenceExternalTransactionId: undefined,
      }),
    ).toThrow(InvalidTransactionInputError);

    const validRefund = WagerTransaction.create({
      ...props,
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: "bet-tx-1",
    });
    expect(validRefund.status).toBe(WagerTransactionStatus.Pending);
    expect(validRefund.requiresReference()).toBe(true);
  });

  it("computes correct ledger direction for BET, WIN, LOSS, REFUND, and ROLLBACK", () => {
    const props = baseProps();
    const bet = WagerTransaction.create({
      ...props,
      kind: WagerTransactionKind.Bet,
    });
    bet.markProcessed(undefined, new Date());

    const win = WagerTransaction.create({
      ...props,
      id: randomUUID(),
      externalTransactionId: "tx-win",
      kind: WagerTransactionKind.Win,
    });
    win.markProcessed(undefined, new Date());

    const loss = WagerTransaction.create({
      ...props,
      id: randomUUID(),
      externalTransactionId: "tx-loss",
      kind: WagerTransactionKind.Loss,
      money: Money.zero("BRL"),
    });

    const refund = WagerTransaction.create({
      ...props,
      id: randomUUID(),
      externalTransactionId: "tx-refund",
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    refund.markProcessed(bet.id, new Date());

    const rollbackBet = WagerTransaction.create({
      ...props,
      id: randomUUID(),
      externalTransactionId: "tx-rb-bet",
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: bet.externalTransactionId,
    });

    const rollbackWin = WagerTransaction.create({
      ...props,
      id: randomUUID(),
      externalTransactionId: "tx-rb-win",
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: win.externalTransactionId,
    });

    const rollbackRefund = WagerTransaction.create({
      ...props,
      id: randomUUID(),
      externalTransactionId: "tx-rb-refund",
      kind: WagerTransactionKind.Rollback,
      referenceExternalTransactionId: refund.externalTransactionId,
    });

    expect(bet.ledgerDirectionFor()).toBe(LedgerDirection.Debit);
    expect(win.ledgerDirectionFor()).toBe(LedgerDirection.Credit);
    expect(refund.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollbackBet.ledgerDirectionFor(bet)).toBe(LedgerDirection.Credit);
    expect(rollbackWin.ledgerDirectionFor(win)).toBe(LedgerDirection.Debit);
    expect(rollbackRefund.ledgerDirectionFor(refund)).toBe(
      LedgerDirection.Debit,
    );
    expect(loss.affectsBalance()).toBe(false);
    expect(() => loss.ledgerDirectionFor()).toThrow(
      InvalidTransactionStateError,
    );
  });

  it("forbids transitions out of terminal states (PROCESSED, REJECTED, FAILED)", () => {
    const tx1 = WagerTransaction.create(baseProps());
    tx1.markProcessed(undefined, new Date());
    expect(tx1.isTerminal()).toBe(true);
    expect(() => tx1.reject(FailureCode.InsufficientFunds)).toThrow(
      InvalidTransactionStateError,
    );

    const tx2 = WagerTransaction.create(baseProps());
    tx2.reject(FailureCode.InsufficientFunds);
    expect(tx2.isTerminal()).toBe(true);
    expect(() => tx2.markProcessed(undefined, new Date())).toThrow(
      InvalidTransactionStateError,
    );

    const tx3 = WagerTransaction.create(baseProps());
    tx3.fail(FailureCode.PermanentInfrastructureFailure);
    expect(tx3.isTerminal()).toBe(true);
    expect(() => tx3.markProcessed(undefined, new Date())).toThrow(
      InvalidTransactionStateError,
    );
  });

  it("validates reference rules (context match, allowed kinds, processed status, exact amount)", () => {
    const props = baseProps();
    const bet = WagerTransaction.create({
      ...props,
      kind: WagerTransactionKind.Bet,
    });
    bet.markProcessed(undefined, new Date());

    const win = WagerTransaction.create({
      ...props,
      id: randomUUID(),
      externalTransactionId: "tx-win",
      kind: WagerTransactionKind.Win,
    });
    win.markProcessed(undefined, new Date());

    // REFUND cannot reference a WIN
    const invalidRefundOfWin = WagerTransaction.create({
      ...props,
      id: randomUUID(),
      externalTransactionId: "tx-ref-win",
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: win.externalTransactionId,
    });
    expect(invalidRefundOfWin.validateReferenceRules(win)).toBe(
      FailureCode.InvalidReferenceKind,
    );

    // Partial refund/rollback is rejected
    const partialRefund = WagerTransaction.create({
      ...props,
      id: randomUUID(),
      externalTransactionId: "tx-ref-partial",
      kind: WagerTransactionKind.Refund,
      money: Money.from({ amount: "10.00", currency: "BRL" }),
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(partialRefund.validateReferenceRules(bet)).toBe(
      FailureCode.ReferenceAmountMismatch,
    );

    // Different roundId is rejected
    const wrongRoundRefund = WagerTransaction.create({
      ...props,
      id: randomUUID(),
      externalTransactionId: "tx-ref-round",
      roundId: "different-round",
      kind: WagerTransactionKind.Refund,
      referenceExternalTransactionId: bet.externalTransactionId,
    });
    expect(wrongRoundRefund.validateReferenceRules(bet)).toBe(
      FailureCode.ReferenceContextMismatch,
    );
  });

  it("detects divergent payload hashes for the same idempotency key", () => {
    const props = baseProps();
    const tx = WagerTransaction.create(props);

    const identicalHash = computeWagerPayloadHash({
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: props.money.toJSON(),
    });

    const divergentHash = computeWagerPayloadHash({
      providerId: props.providerId,
      externalTransactionId: props.externalTransactionId,
      playerId: props.playerId,
      walletId: props.walletId,
      roundId: props.roundId,
      gameId: props.gameId,
      kind: props.kind,
      money: { amount: "99.00", currency: "BRL" },
    });

    expect(tx.matchesPayload(identicalHash)).toBe(true);
    expect(tx.matchesPayload(divergentHash)).toBe(false);
  });

  it("serializes IntegrationEvent, InboxMessage, and OutboxMessage according to contract", () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });
    const entry = wallet.debit({
      entryId: randomUUID(),
      transactionId: randomUUID(),
      money: Money.from({ amount: "25.00", currency: "BRL" }),
    });

    const event = WalletBalanceChanged.from(wallet, entry, {
      correlationId: "corr-1",
    });
    const outbox = OutboxMessage.enqueue(event);
    expect(outbox.isPending()).toBe(true);
    expect(outbox.isDue(new Date())).toBe(true);

    const now = new Date();
    outbox.scheduleRetry(now, 500);
    expect(outbox.attempts).toBe(1);
    expect(outbox.isDue(now)).toBe(false);

    outbox.markPublished(new Date());
    expect(outbox.isPending()).toBe(false);

    const inbox = InboxMessage.receive({
      consumerName: "sqs-consumer",
      messageId: "msg-1",
      payloadHash: "abc",
    });
    expect(inbox.isProcessed()).toBe(false);
    inbox.markProcessed(new Date());
    expect(inbox.isProcessed()).toBe(true);
  });
});

