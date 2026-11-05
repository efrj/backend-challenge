import { FailureCode } from "../wagering/failure-code";

export abstract class DomainError extends Error {
  abstract readonly code: string;

  protected constructor(message: string) {
    super(message);
    this.name = new.target.name;
    Object.setPrototypeOf(this, new.target.prototype);
  }
}

export class InvalidMoneyError extends DomainError {
  readonly code = "INVALID_MONEY";

  constructor(message: string) {
    super(message);
  }
}

export class CurrencyMismatchError extends DomainError {
  readonly code = FailureCode.CurrencyMismatch;

  constructor(expected: string, received: string) {
    super(`Currency mismatch: expected ${expected}, received ${received}`);
  }
}

export class InsufficientFundsError extends DomainError {
  readonly code: FailureCode;

  constructor(
    message: string,
    code: FailureCode = FailureCode.InsufficientFunds,
  ) {
    super(message);
    this.code = code;
  }
}

export class InvalidWalletStateError extends DomainError {
  readonly code = "INVALID_WALLET_STATE";

  constructor(message: string) {
    super(message);
  }
}

export class InvalidTransactionStateError extends DomainError {
  readonly code = "INVALID_TRANSACTION_STATE";

  constructor(message: string) {
    super(message);
  }
}

export class InvalidTransactionInputError extends DomainError {
  readonly code = "INVALID_TRANSACTION_INPUT";

  constructor(message: string) {
    super(message);
  }
}

export class InvalidLedgerEntryError extends DomainError {
  readonly code = "INVALID_LEDGER_ENTRY";

  constructor(message: string) {
    super(message);
  }
}

export class IdempotencyConflictError extends DomainError {
  readonly code = "IDEMPOTENCY_CONFLICT";

  constructor(
    public readonly idempotencyKey: string,
    message = `Idempotency key '${idempotencyKey}' was already used with a different payload`,
  ) {
    super(message);
  }
}

export class DuplicateWalletError extends DomainError {
  readonly code = "DUPLICATE_WALLET";

  constructor(playerId: string, currency: string) {
    super(`Wallet already exists for playerId '${playerId}' and currency '${currency}'`);
  }
}

export class EntityNotFoundError extends DomainError {
  readonly code = "ENTITY_NOT_FOUND";

  constructor(entityName: string, identifier: string) {
    super(`${entityName} '${identifier}' not found`);
  }
}

export class BusinessRejectionError extends DomainError {
  readonly code: FailureCode;

  constructor(
    failureCode: FailureCode,
    message: string,
    public readonly transactionId: string,
    public readonly balance: { amount: string; currency: string },
    public readonly idempotentReplay: boolean = false,
  ) {
    super(message);
    this.code = failureCode;
  }
}

export class TransientInfrastructureError extends DomainError {
  readonly code = "TRANSIENT_INFRASTRUCTURE_ERROR";

  constructor(message: string, public readonly causeError?: unknown) {
    super(message);
  }
}

