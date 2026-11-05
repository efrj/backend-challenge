import {
  InvalidTransactionInputError,
  InvalidTransactionStateError,
} from "../errors/domain-errors";
import { Money } from "../money/money";
import { LedgerDirection } from "../wallet/wallet-ledger-entry";
import { FailureCode } from "./failure-code";

export enum WagerTransactionKind {
  Opening = "OPENING", // internal: initial balance credit on wallet creation
  Bet = "BET",
  Win = "WIN",
  Loss = "LOSS",
  Refund = "REFUND",
  Rollback = "ROLLBACK",
}

export enum WagerTransactionStatus {
  Pending = "PENDING", // accepted, not yet applied
  PendingReference = "PENDING_REFERENCE", // awaiting referenced transaction
  Processed = "PROCESSED", // applied (terminal)
  Rejected = "REJECTED", // business rule violation (terminal)
  Failed = "FAILED", // permanent infrastructure error (terminal, auditable)
}

export interface CreateWagerTransactionProps {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt?: Date;
  correlationId?: string;
}

export interface WagerTransactionState {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  payloadHash: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: Money;
  referenceExternalTransactionId?: string;
  createdAt: Date;
  status: WagerTransactionStatus;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  processedAt?: Date;
  observedBalance?: Money;
  retryCount?: number;
  nextRetryAt?: Date;
  correlationId?: string;
}

export class WagerTransaction {
  private constructor(
    public readonly id: string,
    public readonly providerId: string,
    public readonly externalTransactionId: string,
    public readonly idempotencyKey: string,
    public readonly payloadHash: string,
    public readonly walletId: string,
    public readonly playerId: string,
    public readonly roundId: string,
    public readonly gameId: string,
    public readonly kind: WagerTransactionKind,
    public readonly money: Money,
    /** id no provedor — não o id interno */
    public readonly referenceExternalTransactionId: string | undefined,
    public readonly createdAt: Date,
    private _status: WagerTransactionStatus,
    private _referenceTransactionId?: string,
    private _failureCode?: FailureCode,
    private _processedAt?: Date,
    private _observedBalance?: Money,
    private _retryCount: number = 0,
    private _nextRetryAt?: Date,
    private _correlationId?: string,
  ) {}

  /** Nasce em PENDING. Valida a exigência de referência por kind. */
  static create(props: CreateWagerTransactionProps): WagerTransaction {
    if (!props.id || !props.providerId || !props.externalTransactionId) {
      throw new InvalidTransactionInputError(
        "Transaction id, providerId, and externalTransactionId are required",
      );
    }
    if (!props.idempotencyKey || !props.payloadHash) {
      throw new InvalidTransactionInputError(
        "Transaction idempotencyKey and payloadHash are required",
      );
    }
    if (!props.walletId || !props.playerId || !props.roundId || !props.gameId) {
      throw new InvalidTransactionInputError(
        "Transaction walletId, playerId, roundId, and gameId are required",
      );
    }
    if (!Object.values(WagerTransactionKind).includes(props.kind)) {
      throw new InvalidTransactionInputError(`Invalid transaction kind: '${String(props.kind)}'`);
    }

    if (props.money.isNegative()) {
      throw new InvalidTransactionInputError("Transaction money cannot be negative");
    }

    if (
      (props.kind === WagerTransactionKind.Bet ||
        props.kind === WagerTransactionKind.Win ||
        props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !props.money.isPositive()
    ) {
      throw new InvalidTransactionInputError(
        `Transaction kind '${props.kind}' requires a strictly positive money amount`,
      );
    }

    const normalizedRef =
      props.referenceExternalTransactionId?.trim() || undefined;

    if (
      (props.kind === WagerTransactionKind.Refund ||
        props.kind === WagerTransactionKind.Rollback) &&
      !normalizedRef
    ) {
      throw new InvalidTransactionInputError(
        `Transaction kind '${props.kind}' requires referenceExternalTransactionId`,
      );
    }

    return new WagerTransaction(
      props.id,
      props.providerId,
      props.externalTransactionId,
      props.idempotencyKey,
      props.payloadHash,
      props.walletId,
      props.playerId,
      props.roundId,
      props.gameId,
      props.kind,
      props.money,
      normalizedRef,
      props.createdAt ?? new Date(),
      WagerTransactionStatus.Pending,
      undefined,
      undefined,
      undefined,
      undefined,
      0,
      undefined,
      props.correlationId,
    );
  }

  static rehydrate(state: WagerTransactionState): WagerTransaction {
    return new WagerTransaction(
      state.id,
      state.providerId,
      state.externalTransactionId,
      state.idempotencyKey,
      state.payloadHash,
      state.walletId,
      state.playerId,
      state.roundId,
      state.gameId,
      state.kind,
      state.money,
      state.referenceExternalTransactionId,
      state.createdAt,
      state.status,
      state.referenceTransactionId,
      state.failureCode,
      state.processedAt,
      state.observedBalance,
      state.retryCount ?? 0,
      state.nextRetryAt,
      state.correlationId,
    );
  }

  get status(): WagerTransactionStatus {
    return this._status;
  }

  get referenceTransactionId(): string | undefined {
    return this._referenceTransactionId;
  }

  get failureCode(): FailureCode | undefined {
    return this._failureCode;
  }

  get processedAt(): Date | undefined {
    return this._processedAt;
  }

  get observedBalance(): Money | undefined {
    return this._observedBalance;
  }

  get retryCount(): number {
    return this._retryCount;
  }

  get nextRetryAt(): Date | undefined {
    return this._nextRetryAt;
  }

  get correlationId(): string | undefined {
    return this._correlationId;
  }

  // ---- transições (lançam InvalidTransactionStateError se o estado atual for terminal)
  markProcessed(
    referenceTransactionId: string | undefined,
    at: Date,
    observedBalance?: Money,
  ): void {
    this.assertNotTerminal("markProcessed");
    if (this.requiresReference() && !referenceTransactionId) {
      throw new InvalidTransactionStateError(
        `Transaction '${this.id}' of kind '${this.kind}' cannot be marked PROCESSED without referenceTransactionId`,
      );
    }
    this._status = WagerTransactionStatus.Processed;
    this._referenceTransactionId = referenceTransactionId;
    this._processedAt = at;
    this._failureCode = undefined;
    this._nextRetryAt = undefined;
    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
  }

  markPendingReference(nextRetryAt?: Date, observedBalance?: Money): void {
    this.assertNotTerminal("markPendingReference");
    if (!this.requiresReference()) {
      throw new InvalidTransactionStateError(
        `Only REFUND or ROLLBACK transactions can transition to PENDING_REFERENCE (got '${this.kind}')`,
      );
    }
    this._status = WagerTransactionStatus.PendingReference;
    this._nextRetryAt = nextRetryAt ?? new Date(Date.now() + 250);
    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
  }

  schedulePendingReferenceRetry(now: Date, baseDelayMs = 250): void {
    this.assertNotTerminal("schedulePendingReferenceRetry");
    if (this._status !== WagerTransactionStatus.PendingReference) {
      throw new InvalidTransactionStateError(
        `Cannot schedule retry for transaction in status '${this._status}'`,
      );
    }
    this._retryCount += 1;
    const delayMs = baseDelayMs * Math.pow(2, Math.min(this._retryCount - 1, 8));
    this._nextRetryAt = new Date(now.getTime() + delayMs);
  }

  reject(code: FailureCode, at?: Date, observedBalance?: Money): void {
    this.assertNotTerminal("reject");
    this._status = WagerTransactionStatus.Rejected;
    this._failureCode = code;
    this._processedAt = at ?? new Date();
    this._nextRetryAt = undefined;
    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
  }

  fail(code: FailureCode, at?: Date, observedBalance?: Money): void {
    this.assertNotTerminal("fail");
    this._status = WagerTransactionStatus.Failed;
    this._failureCode = code;
    this._processedAt = at ?? new Date();
    this._nextRetryAt = undefined;
    if (observedBalance) {
      this._observedBalance = observedBalance;
    }
  }

  // ---- consultas de domínio
  isTerminal(): boolean {
    return (
      this._status === WagerTransactionStatus.Processed ||
      this._status === WagerTransactionStatus.Rejected ||
      this._status === WagerTransactionStatus.Failed
    );
  }

  affectsBalance(): boolean {
    return this.kind !== WagerTransactionKind.Loss;
  }

  requiresReference(): boolean {
    return (
      this.kind === WagerTransactionKind.Refund ||
      this.kind === WagerTransactionKind.Rollback
    );
  }

  matchesPayload(payloadHash: string): boolean {
    return this.payloadHash === payloadHash;
  }

  ledgerDirectionFor(reference?: WagerTransaction): LedgerDirection {
    switch (this.kind) {
      case WagerTransactionKind.Opening:
      case WagerTransactionKind.Win:
      case WagerTransactionKind.Refund:
        return LedgerDirection.Credit;
      case WagerTransactionKind.Bet:
        return LedgerDirection.Debit;
      case WagerTransactionKind.Rollback: {
        if (!reference) {
          throw new InvalidTransactionStateError(
            "ROLLBACK requires the referenced transaction to determine ledger direction",
          );
        }
        if (reference.kind === WagerTransactionKind.Bet) {
          return LedgerDirection.Credit;
        }
        if (
          reference.kind === WagerTransactionKind.Win ||
          reference.kind === WagerTransactionKind.Refund
        ) {
          return LedgerDirection.Debit;
        }
        throw new InvalidTransactionStateError(
          `Cannot determine ROLLBACK ledger direction for reference kind '${reference.kind}'`,
        );
      }
      case WagerTransactionKind.Loss:
        throw new InvalidTransactionStateError(
          "LOSS transactions do not affect balance and do not produce ledger entries",
        );
    }
  }

  /**
   * Validates business rules 2, 3, and 5 of Section 7 against a resolved reference transaction.
   * Returns null if valid, or the corresponding FailureCode if invalid.
   */
  validateReferenceRules(reference: WagerTransaction): FailureCode | null {
    // Rule 2: Must belong to the same provider, player, wallet, currency, and round
    if (
      reference.providerId !== this.providerId ||
      reference.playerId !== this.playerId ||
      reference.walletId !== this.walletId ||
      reference.money.currency !== this.money.currency ||
      reference.roundId !== this.roundId
    ) {
      return FailureCode.ReferenceContextMismatch;
    }

    // Rule 3: REFUND only references BET. ROLLBACK references BET, WIN, or REFUND.
    if (this.kind === WagerTransactionKind.Refund) {
      if (reference.kind !== WagerTransactionKind.Bet) {
        return FailureCode.InvalidReferenceKind;
      }
    } else if (this.kind === WagerTransactionKind.Rollback) {
      if (
        reference.kind !== WagerTransactionKind.Bet &&
        reference.kind !== WagerTransactionKind.Win &&
        reference.kind !== WagerTransactionKind.Refund
      ) {
        return FailureCode.InvalidReferenceKind;
      }
    } else if (this.kind === WagerTransactionKind.Win) {
      if (reference.kind !== WagerTransactionKind.Bet) {
        return FailureCode.InvalidReferenceKind;
      }
    }

    // Reference must be PROCESSED (if terminal REJECTED/FAILED, cannot be reversed/referenced)
    if (reference.status !== WagerTransactionStatus.Processed) {
      return FailureCode.ReferenceNotProcessed;
    }

    // Rule 5: Value of REFUND/ROLLBACK must be equal to the value of the reference
    if (this.requiresReference() && !this.money.equals(reference.money)) {
      return FailureCode.ReferenceAmountMismatch;
    }

    return null;
  }

  private assertNotTerminal(operation: string): void {
    if (this.isTerminal()) {
      throw new InvalidTransactionStateError(
        `Cannot execute '${operation}' on transaction '${this.id}' because status '${this._status}' is terminal`,
      );
    }
  }
}

