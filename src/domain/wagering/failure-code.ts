export enum FailureCode {
  /** BET amount exceeds current available wallet balance. */
  InsufficientFunds = "INSUFFICIENT_FUNDS",
  /** ROLLBACK of a credit (WIN/REFUND) would result in a negative wallet balance (Section 7, Rule 9). */
  ReversalInsufficientFunds = "REVERSAL_INSUFFICIENT_FUNDS",
  /** Transaction currency differs from wallet currency. */
  CurrencyMismatch = "CURRENCY_MISMATCH",
  /** Transaction playerId does not match the wallet owner playerId. */
  WalletPlayerMismatch = "WALLET_PLAYER_MISMATCH",
  /** Referenced transaction did not arrive before PENDING_REFERENCE retries/TTL expired. */
  ReferenceNotFound = "REFERENCE_NOT_FOUND",
  /** Referenced transaction is in a non-PROCESSED terminal status (REJECTED or FAILED). */
  ReferenceNotProcessed = "REFERENCE_NOT_PROCESSED",
  /** REFUND referenced non-BET, or ROLLBACK referenced an unsupported kind (LOSS/ROLLBACK/OPENING). */
  InvalidReferenceKind = "INVALID_REFERENCE_KIND",
  /** Referenced transaction belongs to a different provider, player, wallet, currency, or round. */
  ReferenceContextMismatch = "REFERENCE_CONTEXT_MISMATCH",
  /** REFUND/ROLLBACK amount differs from the referenced transaction amount. */
  ReferenceAmountMismatch = "REFERENCE_AMOUNT_MISMATCH",
  /** Referenced transaction was already reversed. */
  AlreadyReversed = "ALREADY_REVERSED",
  /** Permanent infrastructure or processing failure. */
  PermanentInfrastructureFailure = "PERMANENT_INFRASTRUCTURE_FAILURE",
}

