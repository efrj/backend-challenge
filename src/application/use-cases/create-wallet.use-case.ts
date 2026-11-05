import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { randomUUID } from "crypto";
import { DuplicateWalletError } from "../../domain/errors/domain-errors";
import { WagerTransactionProcessed } from "../../domain/events/wager-transaction-processed.event";
import { WalletBalanceChanged } from "../../domain/events/wallet-balance-changed.event";
import { OutboxMessage } from "../../domain/messaging/outbox-message";
import { Money, MoneyProps } from "../../domain/money/money";
import { computeWagerPayloadHash } from "../../domain/wagering/payload-hash";
import {
  WagerTransaction,
  WagerTransactionKind,
} from "../../domain/wagering/wager-transaction";
import { Wallet } from "../../domain/wallet/wallet";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";
import {
  OutboxMessageRecord,
  PersistenceMapper,
  WagerTransactionRecord,
  WalletLedgerEntryRecord,
  WalletRecord,
} from "../../infrastructure/persistence/entities/records";

export interface CreateWalletInput {
  playerId: string;
  initialBalance: MoneyProps;
  correlationId?: string;
}

export interface CreateWalletOutput {
  id: string;
  playerId: string;
  balance: MoneyProps;
  version: number;
}

@Injectable()
export class CreateWalletUseCase {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(StructuredLoggerService)
    private readonly logger: StructuredLoggerService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async execute(input: CreateWalletInput): Promise<CreateWalletOutput> {
    const initialMoney = Money.from(input.initialBalance);
    const walletId = randomUUID();
    const correlationId = input.correlationId ?? randomUUID();
    const now = new Date();

    const wallet = Wallet.open({
      id: walletId,
      playerId: input.playerId,
      initialBalance: initialMoney,
      createdAt: now,
    });

    const fork = this.em.fork();

    try {
      await fork.transactional(async (txEm) => {
        const walletRecord = PersistenceMapper.walletToRecord(wallet);
        txEm.persist(walletRecord);
        await txEm.flush();

        if (initialMoney.isPositive()) {
          const openingTxId = randomUUID();
          const externalTxId = `opening:${wallet.id}`;
          const idempotencyKey = `system:${externalTxId}`;
          const payloadHash = computeWagerPayloadHash({
            providerId: "system",
            externalTransactionId: externalTxId,
            playerId: wallet.playerId,
            walletId: wallet.id,
            roundId: `opening:${wallet.id}`,
            gameId: "wallet-opening",
            kind: WagerTransactionKind.Opening,
            money: initialMoney.toJSON(),
          });

          const openingTx = WagerTransaction.create({
            id: openingTxId,
            providerId: "system",
            externalTransactionId: externalTxId,
            idempotencyKey,
            payloadHash,
            walletId: wallet.id,
            playerId: wallet.playerId,
            roundId: `opening:${wallet.id}`,
            gameId: "wallet-opening",
            kind: WagerTransactionKind.Opening,
            money: initialMoney,
            createdAt: now,
            correlationId,
          });
          openingTx.markProcessed(undefined, now, wallet.balance);

          const ledgerEntry = wallet.createOpeningLedgerEntry({
            entryId: randomUUID(),
            transactionId: openingTx.id,
            at: now,
          });

          const txRecord = PersistenceMapper.transactionToRecord(openingTx);
          txEm.persist(txRecord);
          await txEm.flush();

          if (ledgerEntry) {
            const ledgerRecord =
              PersistenceMapper.ledgerToRecord(ledgerEntry);
            txEm.persist(ledgerRecord);

            const balanceEvent = WalletBalanceChanged.from(
              wallet,
              ledgerEntry,
              {
                correlationId,
                causationId: openingTx.id,
                occurredAt: now,
              },
            );
            const outboxBalance = OutboxMessage.enqueue(balanceEvent);
            txEm.persist(PersistenceMapper.outboxToRecord(outboxBalance));
          }

          const processedEvent = WagerTransactionProcessed.from(
            openingTx,
            wallet,
            {
              correlationId,
              causationId: openingTx.id,
              occurredAt: now,
            },
          );
          const outboxProcessed = OutboxMessage.enqueue(processedEvent);
          txEm.persist(PersistenceMapper.outboxToRecord(outboxProcessed));
          await txEm.flush();
        }
      });
    } catch (err: unknown) {
      if (this.isUniqueConstraintViolation(err)) {
        throw new DuplicateWalletError(input.playerId, initialMoney.currency);
      }
      throw err;
    }

    if (initialMoney.isPositive()) {
      this.metrics.recordTransactionStatus(
        "PROCESSED" as any,
        WagerTransactionKind.Opening,
      );
    }

    this.logger.info("Wallet created", {
      correlationId,
      walletId: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
    });

    return {
      id: wallet.id,
      playerId: wallet.playerId,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
    };
  }

  private isUniqueConstraintViolation(err: unknown): boolean {
    if (!err || typeof err !== "object") return false;
    const code = (err as { code?: string }).code;
    const msg = (err as { message?: string }).message ?? "";
    return code === "23505" || msg.includes("uq_wallets_player_currency");
  }
}
