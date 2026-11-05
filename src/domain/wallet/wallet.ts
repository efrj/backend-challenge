import {
  CurrencyMismatchError,
  InsufficientFundsError,
  InvalidWalletStateError,
} from "../errors/domain-errors";
import { Money } from "../money/money";
import { FailureCode } from "../wagering/failure-code";
import { LedgerDirection, WalletLedgerEntry } from "./wallet-ledger-entry";

export interface OpenWalletProps {
  id: string;
  playerId: string;
  initialBalance: Money;
  createdAt?: Date;
}

export interface WalletState {
  id: string;
  playerId: string;
  currency: string;
  balance: Money;
  version: number;
  createdAt: Date;
  updatedAt: Date;
}

export interface WalletMovementParams {
  entryId: string;
  transactionId: string;
  money: Money;
  at?: Date;
  failureCode?: FailureCode;
}

export class Wallet {
  private constructor(
    public readonly id: string,
    public readonly playerId: string,
    public readonly currency: string,
    private _balance: Money,
    private _version: number,
    public readonly createdAt: Date,
    private _updatedAt: Date,
  ) {}

  static open(props: OpenWalletProps): Wallet {
    if (!props.id || typeof props.id !== "string" || props.id.trim() === "") {
      throw new InvalidWalletStateError("Wallet id is required");
    }
    if (!props.playerId || typeof props.playerId !== "string" || props.playerId.trim() === "") {
      throw new InvalidWalletStateError("Wallet playerId is required");
    }
    if (!props.initialBalance || props.initialBalance.isNegative()) {
      throw new InvalidWalletStateError("Wallet initialBalance cannot be negative");
    }

    const now = props.createdAt ?? new Date();
    return new Wallet(
      props.id,
      props.playerId,
      props.initialBalance.currency,
      props.initialBalance,
      1,
      now,
      now,
    );
  }

  /** Reconstrução a partir da persistência — não revalida transições. */
  static rehydrate(state: WalletState): Wallet {
    return new Wallet(
      state.id,
      state.playerId,
      state.currency,
      state.balance,
      state.version,
      state.createdAt,
      state.updatedAt,
    );
  }

  get balance(): Money {
    return this._balance;
  }

  get version(): number {
    return this._version;
  }

  get updatedAt(): Date {
    return this._updatedAt;
  }

  debit(params: WalletMovementParams): WalletLedgerEntry {
    this.assertSameCurrency(params.money);

    if (!params.money.isPositive()) {
      throw new InvalidWalletStateError("Debit amount must be strictly positive");
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.subtract(params.money);

    if (balanceAfter.isNegative()) {
      throw new InsufficientFundsError(
        `Insufficient funds in wallet '${this.id}': balance ${balanceBefore.toString()}, debit ${params.money.toString()}`,
        params.failureCode ?? FailureCode.InsufficientFunds,
      );
    }

    const now = params.at ?? new Date();
    const entry = WalletLedgerEntry.create({
      id: params.entryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Debit,
      money: params.money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return entry;
  }

  credit(params: WalletMovementParams): WalletLedgerEntry {
    this.assertSameCurrency(params.money);

    if (!params.money.isPositive()) {
      throw new InvalidWalletStateError("Credit amount must be strictly positive");
    }

    const balanceBefore = this._balance;
    const balanceAfter = balanceBefore.add(params.money);
    const now = params.at ?? new Date();

    const entry = WalletLedgerEntry.create({
      id: params.entryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Credit,
      money: params.money,
      balanceBefore,
      balanceAfter,
      createdAt: now,
    });

    this._balance = balanceAfter;
    this._version += 1;
    this._updatedAt = now;

    return entry;
  }

  createOpeningLedgerEntry(params: {
    entryId: string;
    transactionId: string;
    at?: Date;
  }): WalletLedgerEntry | null {
    if (this._balance.isZero()) {
      return null;
    }

    return WalletLedgerEntry.create({
      id: params.entryId,
      walletId: this.id,
      transactionId: params.transactionId,
      direction: LedgerDirection.Credit,
      money: this._balance,
      balanceBefore: Money.zero(this.currency),
      balanceAfter: this._balance,
      createdAt: params.at ?? this.createdAt,
    });
  }

  assertSameCurrency(money: Money): void {
    if (this.currency !== money.currency) {
      throw new CurrencyMismatchError(this.currency, money.currency);
    }
  }
}

