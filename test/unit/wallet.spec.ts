import { describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidLedgerEntryError,
} from "../../src/domain/errors/domain-errors";
import { Money } from "../../src/domain/money/money";
import { FailureCode } from "../../src/domain/wagering/failure-code";
import { Wallet } from "../../src/domain/wallet/wallet";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../src/domain/wallet/wallet-ledger-entry";

describe("Wallet & WalletLedgerEntry (Domain Aggregate & Entities)", () => {
  it("opens a wallet with version 1 and generates an opening CREDIT ledger entry when initialBalance > 0", () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: "1000.00", currency: "BRL" }),
    });

    expect(wallet.version).toBe(1);
    expect(wallet.balance.toJSON()).toEqual({
      amount: "1000.00",
      currency: "BRL",
    });

    const openingEntry = wallet.createOpeningLedgerEntry({
      entryId: randomUUID(),
      transactionId: randomUUID(),
    });
    expect(openingEntry).not.toBeNull();
    expect(openingEntry!.direction).toBe(LedgerDirection.Credit);
    expect(openingEntry!.balanceBefore.toJSON().amount).toBe("0.00");
    expect(openingEntry!.balanceAfter.toJSON().amount).toBe("1000.00");
    expect(openingEntry!.isBalanced()).toBe(true);
  });

  it("increments version and generates balanced ledger entries on debit and credit", () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    const debitEntry = wallet.debit({
      entryId: randomUUID(),
      transactionId: randomUUID(),
      money: Money.from({ amount: "80.00", currency: "BRL" }),
    });

    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(2);
    expect(debitEntry.direction).toBe(LedgerDirection.Debit);
    expect(debitEntry.balanceBefore.toJSON().amount).toBe("100.00");
    expect(debitEntry.balanceAfter.toJSON().amount).toBe("20.00");
    expect(debitEntry.isBalanced()).toBe(true);

    const creditEntry = wallet.credit({
      entryId: randomUUID(),
      transactionId: randomUUID(),
      money: Money.from({ amount: "50.00", currency: "BRL" }),
    });

    expect(wallet.balance.toJSON().amount).toBe("70.00");
    expect(wallet.version).toBe(3);
    expect(creditEntry.direction).toBe(LedgerDirection.Credit);
    expect(creditEntry.balanceBefore.toJSON().amount).toBe("20.00");
    expect(creditEntry.balanceAfter.toJSON().amount).toBe("70.00");
    expect(creditEntry.isBalanced()).toBe(true);
  });

  it("prevents negative balance and preserves balance and version when debit exceeds funds", () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: "20.00", currency: "BRL" }),
    });

    expect(() =>
      wallet.debit({
        entryId: randomUUID(),
        transactionId: randomUUID(),
        money: Money.from({ amount: "80.00", currency: "BRL" }),
      }),
    ).toThrow(InsufficientFundsError);

    expect(wallet.balance.toJSON().amount).toBe("20.00");
    expect(wallet.version).toBe(1);
  });

  it("supports custom FailureCode (REVERSAL_INSUFFICIENT_FUNDS) when reversal debit exceeds balance", () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: "10.00", currency: "BRL" }),
    });

    try {
      wallet.debit({
        entryId: randomUUID(),
        transactionId: randomUUID(),
        money: Money.from({ amount: "50.00", currency: "BRL" }),
        failureCode: FailureCode.ReversalInsufficientFunds,
      });
      throw new Error("Expected InsufficientFundsError");
    } catch (err) {
      expect(err).toBeInstanceOf(InsufficientFundsError);
      expect((err as InsufficientFundsError).code).toBe(
        FailureCode.ReversalInsufficientFunds,
      );
    }
  });

  it("rejects currency mismatch on debit and credit", () => {
    const wallet = Wallet.open({
      id: randomUUID(),
      playerId: randomUUID(),
      initialBalance: Money.from({ amount: "100.00", currency: "BRL" }),
    });

    expect(() =>
      wallet.debit({
        entryId: randomUUID(),
        transactionId: randomUUID(),
        money: Money.from({ amount: "10.00", currency: "USD" }),
      }),
    ).toThrow(CurrencyMismatchError);

    expect(() =>
      wallet.credit({
        entryId: randomUUID(),
        transactionId: randomUUID(),
        money: Money.from({ amount: "10.00", currency: "EUR" }),
      }),
    ).toThrow(CurrencyMismatchError);
  });

  it("enforces structural immutability and arithmetic balance on WalletLedgerEntry", () => {
    expect(() =>
      WalletLedgerEntry.create({
        id: randomUUID(),
        walletId: randomUUID(),
        transactionId: randomUUID(),
        direction: LedgerDirection.Debit,
        money: Money.from({ amount: "25.00", currency: "BRL" }),
        balanceBefore: Money.from({ amount: "100.00", currency: "BRL" }),
        balanceAfter: Money.from({ amount: "80.00", currency: "BRL" }), // wrong arithmetic!
      }),
    ).toThrow(InvalidLedgerEntryError);
  });
});

