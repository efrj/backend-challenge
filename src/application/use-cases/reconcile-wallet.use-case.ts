import { LockMode } from "@mikro-orm/core";
import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { EntityNotFoundError } from "../../domain/errors/domain-errors";
import { Money, MoneyProps } from "../../domain/money/money";
import { MetricsService } from "../../infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "../../infrastructure/observability/structured-logger.service";
import {
  PersistenceMapper,
  WalletRecord,
} from "../../infrastructure/persistence/entities/records";

export interface ReconcileWalletOutput {
  walletId: string;
  storedBalance: MoneyProps;
  calculatedBalance: MoneyProps;
  difference: MoneyProps;
  consistent: boolean;
  checkedEntries: number;
}

@Injectable()
export class ReconcileWalletUseCase {
  constructor(
    @Inject(EntityManager) private readonly em: EntityManager,
    @Inject(StructuredLoggerService)
    private readonly logger: StructuredLoggerService,
    @Inject(MetricsService) private readonly metrics: MetricsService,
  ) {}

  async execute(
    walletId: string,
    correlationId?: string,
  ): Promise<ReconcileWalletOutput> {
    const fork = this.em.fork();

    return await fork.transactional(async (txEm) => {
      const walletRecord = await txEm.findOne(
        WalletRecord,
        { id: walletId },
        { lockMode: LockMode.PESSIMISTIC_READ },
      );

      if (!walletRecord) {
        throw new EntityNotFoundError("Wallet", walletId);
      }

      const wallet = PersistenceMapper.walletToDomain(walletRecord);

      const rows = await txEm
        .getConnection()
        .execute<
          Array<{
            checked_entries: string;
            calculated_balance: string;
          }>
        >(
          `SELECT
             COUNT(*)::text AS checked_entries,
             COALESCE(
               SUM(
                 CASE
                   WHEN direction = 'CREDIT' THEN money_amount
                   WHEN direction = 'DEBIT' THEN -money_amount
                   ELSE 0
                 END
               ),
               0.00
             )::numeric(20, 2)::text AS calculated_balance
           FROM wallet_ledger_entries
           WHERE wallet_id = ?`,
          [walletId],
        );

      const agg = rows[0] ?? {
        checked_entries: "0",
        calculated_balance: "0.00",
      };

      const checkedEntries = Number(agg.checked_entries);
      const calculatedBalance = Money.rehydrate({
        amount: agg.calculated_balance,
        currency: wallet.currency,
      });

      const storedBalance = wallet.balance;
      const difference = storedBalance.subtract(calculatedBalance);
      const consistent = difference.isZero();

      if (!consistent) {
        this.metrics.recordReconciliationDiscrepancy();
        this.logger.error("Wallet reconciliation discrepancy detected", {
          correlationId,
          walletId: wallet.id,
          consistent: false,
          checkedEntries,
          differenceCurrency: difference.currency,
        });
      } else {
        this.logger.info("Wallet reconciliation completed", {
          correlationId,
          walletId: wallet.id,
          consistent: true,
          checkedEntries,
        });
      }

      return {
        walletId: wallet.id,
        storedBalance: storedBalance.toJSON(),
        calculatedBalance: calculatedBalance.toJSON(),
        difference: difference.toJSON(),
        consistent,
        checkedEntries,
      };
    });
  }
}

