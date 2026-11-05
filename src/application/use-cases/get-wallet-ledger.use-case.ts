import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import {
  EntityNotFoundError,
  InvalidTransactionInputError,
} from "../../domain/errors/domain-errors";
import { MoneyProps } from "../../domain/money/money";
import { LedgerDirection } from "../../domain/wallet/wallet-ledger-entry";
import {
  PersistenceMapper,
  WalletLedgerEntryRecord,
  WalletRecord,
} from "../../infrastructure/persistence/entities/records";

export interface LedgerEntryDto {
  id: string;
  walletId: string;
  transactionId: string;
  direction: LedgerDirection;
  money: MoneyProps;
  balanceBefore: MoneyProps;
  balanceAfter: MoneyProps;
  createdAt: string;
}

export interface GetWalletLedgerOutput {
  items: LedgerEntryDto[];
  nextCursor: string | null;
  hasMore: boolean;
}

@Injectable()
export class GetWalletLedgerUseCase {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async execute(params: {
    walletId: string;
    cursor?: string;
    limit?: number;
  }): Promise<GetWalletLedgerOutput> {
    const limit = Math.min(Math.max(Number(params.limit ?? 50), 1), 200);
    const fork = this.em.fork();

    const walletRecord = await fork.findOne(WalletRecord, {
      id: params.walletId,
    });
    if (!walletRecord) {
      throw new EntityNotFoundError("Wallet", params.walletId);
    }

    let afterSeq = "0";
    if (params.cursor) {
      try {
        const decoded = JSON.parse(
          Buffer.from(params.cursor, "base64url").toString("utf8"),
        ) as { seq?: string };
        if (!decoded.seq || !/^\d+$/.test(String(decoded.seq))) {
          throw new Error("Invalid seq in cursor");
        }
        afterSeq = String(decoded.seq);
      } catch {
        throw new InvalidTransactionInputError("Invalid pagination cursor");
      }
    }

    const rows = await fork
      .getConnection()
      .execute<
        Array<{
          id: string;
          sequence_num: string;
          wallet_id: string;
          transaction_id: string;
          direction: string;
          money_amount: string;
          money_currency: string;
          balance_before_amount: string;
          balance_after_amount: string;
          created_at: Date;
        }>
      >(
        `SELECT id, sequence_num, wallet_id, transaction_id, direction,
                money_amount, money_currency, balance_before_amount, balance_after_amount, created_at
         FROM wallet_ledger_entries
         WHERE wallet_id = ? AND sequence_num > ?
         ORDER BY sequence_num ASC
         LIMIT ?`,
        [params.walletId, afterSeq, limit + 1],
      );

    const hasMore = rows.length > limit;
    const pageRows = hasMore ? rows.slice(0, limit) : rows;

    const items: LedgerEntryDto[] = pageRows.map((row) => {
      const rec = new WalletLedgerEntryRecord();
      rec.id = row.id;
      rec.sequenceNum = String(row.sequence_num);
      rec.walletId = row.wallet_id;
      rec.transactionId = row.transaction_id;
      rec.direction = row.direction;
      rec.moneyAmount = row.money_amount;
      rec.moneyCurrency = row.money_currency;
      rec.balanceBeforeAmount = row.balance_before_amount;
      rec.balanceAfterAmount = row.balance_after_amount;
      rec.createdAt = new Date(row.created_at);

      const entry = PersistenceMapper.ledgerToDomain(rec);
      return {
        id: entry.id,
        walletId: entry.walletId,
        transactionId: entry.transactionId,
        direction: entry.direction,
        money: entry.money.toJSON(),
        balanceBefore: entry.balanceBefore.toJSON(),
        balanceAfter: entry.balanceAfter.toJSON(),
        createdAt: entry.createdAt.toISOString(),
      };
    });

    const lastRow = pageRows[pageRows.length - 1];
    const nextCursor =
      hasMore && lastRow
        ? Buffer.from(
            JSON.stringify({ seq: String(lastRow.sequence_num), id: lastRow.id }),
            "utf8",
          ).toString("base64url")
        : null;

    return {
      items,
      nextCursor,
      hasMore,
    };
  }
}

