import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import {
  EntityNotFoundError,
  IdempotencyConflictError,
  InsufficientFundsError,
  InvalidTransactionInputError,
  TransientInfrastructureError,
} from "../../domain/errors/domain-errors";
import { WagerTransactionPendingReference } from "../../domain/events/wager-transaction-pending-reference.event";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed.event";
import { WagerTransactionRejected } from "../../domain/events/wager-transaction-rejected.event";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed.event";
import { InboxMessage } from "../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money, MoneyProps } from "../../domain/money/money";
import { FailureCode } from "../../domain/wagering/failure-code";
import { computeWagerPayloadHash } from "../../domain/wagering/payload-hash";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import {
   LedgerDirection,
  WalletLedgerEntry,
} from "../../domain/wallet/wallet-ledger-entry";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";
import {
  InboxMessageRecord,
  PersistenceMapper,
  WagerTransactionRecord,
  WalletRecord,
} from "../../infrastructure/persistence/entities/records";

export interface ProcessWagerTransactionInput {
  idempotencyKey: string;
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  correlationId?: string;
  inbox?: {
    consumerName: string;
    messageId: string;
    payloadHash: string;
  };
}

export interface ProcessWagerTransactionOutput {
  transactionId: string;
  status: WagerTransactionStatus;
  balance: MoneyProps;
  idempotentReplay: boolean;
  failureCode?: FailureCode;
  inboxDuplicate?: boolean;
}

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class ProcessWagerTransactionUseCase {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(StructuredLoggerService)
    private readonly logger: StructuredLoggerService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async execute(
    input: ProcessWagerTransactionInput,
  ): Promise<ProcessWagerTransactionOutput> {
    const startMs = performance.now();
    const correlationId = input.correlationId ?? randomUUID();

    try {
      this.validateExternalInput(input);
      const money = Money.from(input.money);
      const payloadHash = computeWagerPayloadHash({
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        playerId: input.playerId,
        walletId: input.walletId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money: money.toJSON(),
        referenceExternalTransactionId: input.referenceExternalTransactionId,
      });

      const maxRetries = 4;
      for (let attempt = 1; attempt <= maxRetries; attempt++) {
        try {
          const result = await this.executeTransactional(
            input,
            money,
            payloadHash,
            correlationId,
          );
          return result;
        } catch (err: unknown) {
          if (this.isUniqueConstraintViolation(err)) {
            const recovered = await this.recoverFromUniqueViolation(
              input,
              payloadHash,
            );
            if (recovered) {
              return recovered;
            }
          }

          if (this.isTransientDbError(err)) {
            this.metrics.recordLockConflict();
            if (attempt < maxRetries) {
              this.metrics.recordRetry("db_lock");
              const backoffMs = 15 * Math.pow(2, attempt - 1) + Math.random() * 20;
              await new Promise((r) => setTimeout(r, backoffMs));
              continue;
            }
            throw new TransientInfrastructureError(
              "Database transaction failed after lock/serialization retries",
              err,
            );
          }

          throw err;
        }
      }

      throw new TransientInfrastructureError("Exhausted transaction retries");
    } finally {
      this.metrics.recordProcessingLatency(performance.now() - startMs);
    }
  }

  private validateExternalInput(input: ProcessWagerTransactionInput): void {
    if (
      !input ||
      typeof input.idempotencyKey !== "string" ||
      input.idempotencyKey.trim() === ""
    ) {
      throw new InvalidTransactionInputError(
        "Idempotency-Key is required and must be a non-empty string",
      );
    }

    if (input.kind === WagerTransactionKind.Opening) {
      throw new InvalidTransactionInputError(
        "Transaction kind 'OPENING' is internal and cannot be submitted via API or queue",
      );
    }

    if (!Object.values(WagerTransactionKind).includes(input.kind)) {
      throw new InvalidTransactionInputError(
        `Unsupported transaction kind '${String(input.kind)}'`,
      );
    }

    if (
      !input.providerId?.trim() ||
      !input.externalTransactionId?.trim() ||
      !input.playerId?.trim() ||
      !input.walletId?.trim() ||
      !input.roundId?.trim() ||
      !input.gameId?.trim()
    ) {
      throw new InvalidTransactionInputError(
        "providerId, externalTransactionId, playerId, walletId, roundId, and gameId are required",
      );
    }

    if (!UUID_REGEX.test(input.walletId)) {
      throw new InvalidTransactionInputError(
        `walletId '${input.walletId}' must be a valid UUID`,
      );
    }

    if (
      (input.kind === WagerTransactionKind.Refund ||
        input.kind === WagerTransactionKind.Rollback) &&
      (!input.referenceExternalTransactionId ||
        input.referenceExternalTransactionId.trim() === "")
    ) {
      throw new InvalidTransactionInputError(
        `Transaction kind '${input.kind}' requires referenceExternalTransactionId`,
      );
    }
  }

  private async executeTransactional(
    input: ProcessWagerTransactionInput,
    money: Money,
    payloadHash: string,
    correlationId: string,
  ): Promise<ProcessWagerTransactionOutput> {
    const fork = this.em.fork();
    const now = new Date();

    return await fork.transactional(async (txEm) => {
      // 1. If SQS inbox is provided, check persistent inbox first
      if (input.inbox) {
        const existingInbox = await txEm.findOne(
          InboxMessageRecord,
          {
            consumerName: input.inbox.consumerName,
            messageId: input.inbox.messageId,
          },
          { lockMode: LockMode.PESSIMISTIC_WRITE },
        );

        if (existingInbox && existingInbox.processedAt) {
          this.metrics.recordDuplicate("sqs_inbox");
          const existingTxRecord = await this.findExistingTransaction(
            txEm,
            input.idempotencyKey,
            input.providerId,
            input.externalTransactionId,
          );
          if (existingTxRecord) {
            const existingTx =
              PersistenceMapper.transactionToDomain(existingTxRecord);
            const balance = await this.resolveObservedBalance(
              txEm,
              existingTx,
            );
            return {
              transactionId: existingTx.id,
              status: existingTx.status,
              balance,
              idempotentReplay: true,
              failureCode: existingTx.failureCode,
              inboxDuplicate: true,
            };
          }
        }
      }

      // 2. Fast pre-lock check for already committed idempotent transaction
      const preExistingRecord = await this.findExistingTransaction(
        txEm,
        input.idempotencyKey,
        input.providerId,
        input.externalTransactionId,
      );
      if (preExistingRecord) {
        return await this.handleExistingTransaction(
          txEm,
          preExistingRecord,
          input,
          payloadHash,
          now,
        );
      }

      // 3. Acquire per-wallet pessimistic write lock (SELECT ... FOR UPDATE)
      // Unit of concurrency is walletId (Section 8)
      const walletRecord = await txEm.findOne(
        WalletRecord,
        { id: input.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!walletRecord) {
        throw new EntityNotFoundError("Wallet", input.walletId);
      }

      // 4. Re-check idempotency after acquiring the wallet row lock!
      // Concurrent identical requests waiting on the wallet lock will see the winner's committed row here.
      const postLockExistingRecord = await this.findExistingTransaction(
        txEm,
        input.idempotencyKey,
        input.providerId,
        input.externalTransactionId,
      );
      if (postLockExistingRecord) {
        return await this.handleExistingTransaction(
          txEm,
          postLockExistingRecord,
          input,
          payloadHash,
          now,
        );
      }

      const wallet = PersistenceMapper.walletToDomain(walletRecord);

      const tx = WagerTransaction.create({
        id: randomUUID(),
        providerId: input.providerId,
        externalTransactionId: input.externalTransactionId,
        idempotencyKey: input.idempotencyKey,
        payloadHash,
        walletId: input.walletId,
        playerId: input.playerId,
        roundId: input.roundId,
        gameId: input.gameId,
        kind: input.kind,
        money,
        referenceExternalTransactionId: input.referenceExternalTransactionId,
        createdAt: now,
        correlationId,
      });

      // 5. Evaluate domain invariants & business rules
      let ledgerEntry: WalletLedgerEntry | undefined;
      let referenceTx: WagerTransaction | undefined;

      if (wallet.playerId !== tx.playerId) {
        tx.reject(FailureCode.WalletPlayerMismatch, now, wallet.balance);
      } else if (wallet.currency !== tx.money.currency) {
        tx.reject(FailureCode.CurrencyMismatch, now, wallet.balance);
      } else if (
        tx.requiresReference() ||
        (tx.kind === WagerTransactionKind.Win &&
          tx.referenceExternalTransactionId)
      ) {
        const refRecord = await txEm.findOne(WagerTransactionRecord, {
          providerId: tx.providerId,
          externalTransactionId: tx.referenceExternalTransactionId!,
        });

        if (
          !refRecord ||
          refRecord.status === WagerTransactionStatus.Pending ||
          refRecord.status === WagerTransactionStatus.PendingReference
        ) {
          if (tx.requiresReference()) {
            const firstRetryDelayMs = Number(
              process.env.PENDING_REF_INITIAL_BACKOFF_MS ?? 200,
            );
            tx.markPendingReference(
              new Date(now.getTime() + firstRetryDelayMs),
              wallet.balance,
            );
          }
        } else {
          referenceTx = PersistenceMapper.transactionToDomain(refRecord);
          const ruleViolation = tx.validateReferenceRules(referenceTx);
          if (ruleViolation) {
            tx.reject(ruleViolation, now, wallet.balance);
          } else if (tx.requiresReference()) {
            const existingReversal = await txEm.findOne(
              WagerTransactionRecord,
              {
                referenceTransactionId: referenceTx.id,
                status: WagerTransactionStatus.Processed,
                kind: {
                  $in: [
                    WagerTransactionKind.Refund,
                    WagerTransactionKind.Rollback,
                  ],
                },
              },
            );
            if (existingReversal) {
              tx.reject(FailureCode.AlreadyReversed, now, wallet.balance);
            }
          }
        }
      }

      // 6. Apply financial effect if still PENDING
      if (tx.status === WagerTransactionStatus.Pending) {
        if (tx.affectsBalance()) {
          const direction = tx.ledgerDirectionFor(referenceTx);
          if (direction === LedgerDirection.Debit) {
            const debitFailureCode =
              tx.kind === WagerTransactionKind.Rollback
                ? FailureCode.ReversalInsufficientFunds
                : FailureCode.InsufficientFunds;
            try {
              ledgerEntry = wallet.debit({
                entryId: randomUUID(),
                transactionId: tx.id,
                money: tx.money,
                at: now,
                failureCode: debitFailureCode,
              });
            } catch (err) {
              if (err instanceof InsufficientFundsError) {
                tx.reject(err.code, now, wallet.balance);
              } else {
                throw err;
              }
            }
          } else {
            ledgerEntry = wallet.credit({
              entryId: randomUUID(),
              transactionId: tx.id,
              money: tx.money,
              at: now,
            });
          }
        }

        if (tx.status === WagerTransactionStatus.Pending) {
          tx.markProcessed(referenceTx?.id, now, wallet.balance);
        }
      }

      // 7. Persist Wallet, WagerTransaction, WalletLedgerEntry, InboxMessage, and OutboxMessage atomically
      PersistenceMapper.walletToRecord(wallet, walletRecord);
      txEm.persist(walletRecord);

      const txRecord = PersistenceMapper.transactionToRecord(tx);
      txEm.persist(txRecord);
      await txEm.flush();

      if (ledgerEntry) {
        const ledgerRecord = PersistenceMapper.ledgerToRecord(ledgerEntry);
        txEm.persist(ledgerRecord);
      }

      if (input.inbox) {
        const inboxDomain = InboxMessage.receive({
          consumerName: input.inbox.consumerName,
          messageId: input.inbox.messageId,
          payloadHash: input.inbox.payloadHash,
          receivedAt: now,
        });
        inboxDomain.markProcessed(now);
        txEm.persist(PersistenceMapper.inboxToRecord(inboxDomain));
      }

      // Enqueue transactional outbox integration events
      const eventCtx = {
        correlationId,
        causationId: tx.id,
        occurredAt: now,
      };

      if (tx.status === WagerTransactionStatus.Processed) {
        const processedEvent = WagerTransactionProcessed.from(
          tx,
          wallet,
          eventCtx,
        );
        txEm.persist(
          PersistenceMapper.outboxToRecord(
            OutboxMessage.enqueue(processedEvent),
          ),
        );

        if (ledgerEntry) {
          const balanceChangedEvent = WalletBalanceChanged.from(
            wallet,
            ledgerEntry,
            eventCtx,
          );
          txEm.persist(
            PersistenceMapper.outboxToRecord(
              OutboxMessage.enqueue(balanceChangedEvent),
            ),
          );
        }
      } else if (tx.status === WagerTransactionStatus.Rejected) {
        const rejectedEvent = WagerTransactionRejected.from(tx, eventCtx);
        txEm.persist(
          PersistenceMapper.outboxToRecord(
            OutboxMessage.enqueue(rejectedEvent),
          ),
        );
      } else if (tx.status === WagerTransactionStatus.PendingReference) {
        const pendingRefEvent = WagerTransactionPendingReference.from(
          tx,
          eventCtx,
        );
        txEm.persist(
          PersistenceMapper.outboxToRecord(
            OutboxMessage.enqueue(pendingRefEvent),
          ),
        );
      }

      await txEm.flush();

      this.metrics.recordTransactionStatus(tx.status, tx.kind);
      this.logger.info("Wager transaction evaluated", {
        correlationId,
        messageId: input.inbox?.messageId,
        transactionId: tx.id,
        walletId: wallet.id,
        providerId: tx.providerId,
        kind: tx.kind,
        status: tx.status,
        failureCode: tx.failureCode,
      });

      return {
        transactionId: tx.id,
        status: tx.status,
        balance: wallet.balance.toJSON(),
        idempotentReplay: false,
        failureCode: tx.failureCode,
      };
    });
  }

  /**
   * Used by the scheduled PendingReferenceWorker to re-evaluate a PENDING_REFERENCE transaction
   * with exponential backoff and a maximum retry limit (Section 7.1).
   */
  async reprocessPendingReference(
    transactionId: string,
    maxAttempts = Number(process.env.PENDING_REF_MAX_ATTEMPTS ?? 5),
    baseDelayMs = Number(process.env.PENDING_REF_INITIAL_BACKOFF_MS ?? 200),
  ): Promise<WagerTransactionStatus> {
    const fork = this.em.fork();
    const now = new Date();

    return await fork.transactional(async (txEm) => {
      const txRecord = await txEm.findOne(
        WagerTransactionRecord,
        { id: transactionId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (
        !txRecord ||
        txRecord.status !== WagerTransactionStatus.PendingReference
      ) {
        return (
          (txRecord?.status as WagerTransactionStatus) ??
          WagerTransactionStatus.Failed
        );
      }

      const walletRecord = await txEm.findOne(
        WalletRecord,
        { id: txRecord.walletId },
        { lockMode: LockMode.PESSIMISTIC_WRITE },
      );

      if (!walletRecord) {
        return WagerTransactionStatus.Failed;
      }

      const wallet = PersistenceMapper.walletToDomain(walletRecord);
      const tx = PersistenceMapper.transactionToDomain(txRecord);
      const correlationId = tx.correlationId ?? randomUUID();
      const eventCtx = {
        correlationId,
        causationId: tx.id,
        occurredAt: now,
      };

      const refRecord = tx.referenceExternalTransactionId
        ? await txEm.findOne(WagerTransactionRecord, {
            providerId: tx.providerId,
            externalTransactionId: tx.referenceExternalTransactionId,
          })
        : null;

      // Still missing or still pending
      if (
        !refRecord ||
        refRecord.status === WagerTransactionStatus.Pending ||
        refRecord.status === WagerTransactionStatus.PendingReference
      ) {
        this.metrics.recordRetry("pending_reference");

        if (tx.retryCount + 1 >= maxAttempts) {
          tx.reject(FailureCode.ReferenceNotFound, now, wallet.balance);
          PersistenceMapper.transactionToRecord(tx, txRecord);
          txEm.persist(txRecord);

          const rejectedEvent = WagerTransactionRejected.from(tx, eventCtx);
          txEm.persist(
            PersistenceMapper.outboxToRecord(
              OutboxMessage.enqueue(rejectedEvent),
            ),
          );

          await txEm.flush();
          this.metrics.recordTransactionStatus(tx.status, tx.kind);
          this.logger.warn(
            "PENDING_REFERENCE transaction rejected after exhausting retries",
            {
              correlationId,
              transactionId: tx.id,
              walletId: wallet.id,
              providerId: tx.providerId,
              failureCode: tx.failureCode,
              attempts: tx.retryCount + 1,
            },
          );
          return tx.status;
        }

        tx.schedulePendingReferenceRetry(now, baseDelayMs);
        PersistenceMapper.transactionToRecord(tx, txRecord);
        txEm.persist(txRecord);
        await txEm.flush();
        return tx.status;
      }

      // Reference is now available in a terminal state
      const referenceTx = PersistenceMapper.transactionToDomain(refRecord);
      const ruleViolation = tx.validateReferenceRules(referenceTx);

      if (ruleViolation) {
        tx.reject(ruleViolation, now, wallet.balance);
      } else {
        const existingReversal = await txEm.findOne(WagerTransactionRecord, {
          referenceTransactionId: referenceTx.id,
          status: WagerTransactionStatus.Processed,
          kind: {
            $in: [WagerTransactionKind.Refund, WagerTransactionKind.Rollback],
          },
        });
        if (existingReversal) {
          tx.reject(FailureCode.AlreadyReversed, now, wallet.balance);
        }
      }

      let ledgerEntry: WalletLedgerEntry | undefined;

      if (tx.status === WagerTransactionStatus.PendingReference) {
        const direction = tx.ledgerDirectionFor(referenceTx);
        if (direction === LedgerDirection.Debit) {
          try {
            ledgerEntry = wallet.debit({
              entryId: randomUUID(),
              transactionId: tx.id,
              money: tx.money,
              at: now,
              failureCode: FailureCode.ReversalInsufficientFunds,
            });
          } catch (err) {
            if (err instanceof InsufficientFundsError) {
              tx.reject(err.code, now, wallet.balance);
            } else {
              throw err;
            }
          }
        } else {
          ledgerEntry = wallet.credit({
            entryId: randomUUID(),
            transactionId: tx.id,
            money: tx.money,
            at: now,
          });
        }

        if (tx.status === WagerTransactionStatus.PendingReference) {
          tx.markProcessed(referenceTx.id, now, wallet.balance);
        }
      }

      PersistenceMapper.walletToRecord(wallet, walletRecord);
      txEm.persist(walletRecord);

      PersistenceMapper.transactionToRecord(tx, txRecord);
      txEm.persist(txRecord);
      await txEm.flush();

      if (ledgerEntry) {
        txEm.persist(PersistenceMapper.ledgerToRecord(ledgerEntry));
      }

      if (tx.status === WagerTransactionStatus.Processed) {
        const processedEvent = WagerTransactionProcessed.from(
          tx,
          wallet,
          eventCtx,
        );
        txEm.persist(
          PersistenceMapper.outboxToRecord(
            OutboxMessage.enqueue(processedEvent),
          ),
        );

        if (ledgerEntry) {
          const balanceEvent = WalletBalanceChanged.from(
            wallet,
            ledgerEntry,
            eventCtx,
          );
          txEm.persist(
            PersistenceMapper.outboxToRecord(
              OutboxMessage.enqueue(balanceEvent),
            ),
          );
        }
      } else if (tx.status === WagerTransactionStatus.Rejected) {
        const rejectedEvent = WagerTransactionRejected.from(tx, eventCtx);
        txEm.persist(
          PersistenceMapper.outboxToRecord(
            OutboxMessage.enqueue(rejectedEvent),
          ),
        );
      }

      await txEm.flush();
      this.metrics.recordTransactionStatus(tx.status, tx.kind);

      this.logger.info("PENDING_REFERENCE transaction resolved", {
        correlationId,
        transactionId: tx.id,
        walletId: wallet.id,
        providerId: tx.providerId,
        status: tx.status,
        failureCode: tx.failureCode,
      });

      return tx.status;
    });
  }

  private async findExistingTransaction(
    txEm: EntityManager,
    idempotencyKey: string,
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionRecord | null> {
    return await txEm.findOne(WagerTransactionRecord, {
      $or: [
        { idempotencyKey },
        { providerId, externalTransactionId },
      ],
    });
  }

  private async handleExistingTransaction(
    txEm: EntityManager,
    existingRecord: WagerTransactionRecord,
    input: ProcessWagerTransactionInput,
    payloadHash: string,
    now: Date,
  ): Promise<ProcessWagerTransactionOutput> {
    const existingTx = PersistenceMapper.transactionToDomain(existingRecord);

    if (
      existingTx.idempotencyKey !== input.idempotencyKey ||
      !existingTx.matchesPayload(payloadHash)
    ) {
      this.metrics.recordIdempotencyConflict();
      throw new IdempotencyConflictError(input.idempotencyKey);
    }

    if (input.inbox) {
      const existingInbox = await txEm.findOne(InboxMessageRecord, {
        consumerName: input.inbox.consumerName,
        messageId: input.inbox.messageId,
      });
      if (!existingInbox) {
        const inboxDomain = InboxMessage.receive({
          consumerName: input.inbox.consumerName,
          messageId: input.inbox.messageId,
          payloadHash: input.inbox.payloadHash,
          receivedAt: now,
        });
        inboxDomain.markProcessed(now);
        txEm.persist(PersistenceMapper.inboxToRecord(inboxDomain));
        await txEm.flush();
      }
      this.metrics.recordDuplicate("sqs_inbox");
    } else {
      this.metrics.recordDuplicate("http_idempotency");
    }

    const balance = await this.resolveObservedBalance(txEm, existingTx);
    return {
      transactionId: existingTx.id,
      status: existingTx.status,
      balance,
      idempotentReplay: true,
      failureCode: existingTx.failureCode,
    };
  }

  private async resolveObservedBalance(
    txEm: EntityManager,
    tx: WagerTransaction,
  ): Promise<MoneyProps> {
    if (tx.observedBalance) {
      return tx.observedBalance.toJSON();
    }
    const walletRecord = await txEm.findOne(WalletRecord, { id: tx.walletId });
    if (walletRecord) {
      return {
        amount: walletRecord.balanceAmount,
        currency: walletRecord.currency,
      };
    }
    return Money.zero(tx.money.currency).toJSON();
  }

  private async recoverFromUniqueViolation(
    input: ProcessWagerTransactionInput,
    payloadHash: string,
  ): Promise<ProcessWagerTransactionOutput | null> {
    const fork = this.em.fork();
    const existingRecord = await this.findExistingTransaction(
      fork,
      input.idempotencyKey,
      input.providerId,
      input.externalTransactionId,
    );
    if (!existingRecord) {
      return null;
    }

    return await fork.transactional(async (txEm) => {
      return await this.handleExistingTransaction(
        txEm,
        existingRecord,
        input,
        payloadHash,
        new Date(),
      );
    });
  }

  private isUniqueConstraintViolation(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const code = (err as { code?: string }).code;
    const msg = (err as { message?: string }).message ?? "";
    return (
      code === "23505" ||
      msg.includes("uq_wager_tx_idempotency_key") ||
      msg.includes("uq_wager_tx_provider_external") ||
      msg.includes("inbox_messages_pkey")
    );
  }

  private isTransientDbError(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const code = (err as { code?: string }).code;
    return code === "40P01" || code === "40001" || code === "55P03";
  }
}
