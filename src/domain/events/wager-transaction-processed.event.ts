import { randomUUID } from "crypto";
import { MoneyProps } from "../money/money";
import { WagerTransaction, WagerTransactionKind } from "../wagering/wager-transaction";
import { Wallet } from "../wallet/wallet";
import { EventContext, IntegrationEvent, IntegrationEventProps } from "./integration-event";

export interface WagerTransactionProcessedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  balance: MoneyProps;
  referenceTransactionId?: string;
  processedAt: string;
}

export class WagerTransactionProcessed extends IntegrationEvent<WagerTransactionProcessedData> {
  readonly eventType = "WagerTransactionProcessed";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionProcessedData>) {
    super(props);
  }

  static from(
    tx: WagerTransaction,
    wallet: Wallet,
    ctx: EventContext,
  ): WagerTransactionProcessed {
    const processedAt = tx.processedAt ?? ctx.occurredAt ?? new Date();
    return new WagerTransactionProcessed({
      eventId: ctx.eventId ?? randomUUID(),
      aggregateId: wallet.id,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? tx.id,
      occurredAt: ctx.occurredAt ?? processedAt,
      data: {
        transactionId: tx.id,
        providerId: tx.providerId,
        externalTransactionId: tx.externalTransactionId,
        walletId: tx.walletId,
        playerId: tx.playerId,
        roundId: tx.roundId,
        gameId: tx.gameId,
        kind: tx.kind,
        money: tx.money.toJSON(),
        balance: wallet.balance.toJSON(),
        referenceTransactionId: tx.referenceTransactionId,
        processedAt: processedAt.toISOString(),
      },
    });
  }
}

