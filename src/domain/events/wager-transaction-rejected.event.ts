import { randomUUID } from "crypto";
import { MoneyProps } from "../money/money";
import { FailureCode } from "../wagering/failure-code";
import { WagerTransaction, WagerTransactionKind } from "../wagering/wager-transaction";
import { EventContext, IntegrationEvent, IntegrationEventProps } from "./integration-event";

export interface WagerTransactionRejectedData {
  transactionId: string;
  providerId: string;
  externalTransactionId: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  money: MoneyProps;
  failureCode: FailureCode;
  rejectedAt: string;
}

export class WagerTransactionRejected extends IntegrationEvent<WagerTransactionRejectedData> {
  readonly eventType = "WagerTransactionRejected";
  readonly version = 1;

  private constructor(props: IntegrationEventProps<WagerTransactionRejectedData>) {
    super(props);
  }

  static from(
    tx: WagerTransaction,
    ctx: EventContext,
  ): WagerTransactionRejected {
    const rejectedAt = tx.processedAt ?? ctx.occurredAt ?? new Date();
    return new WagerTransactionRejected({
      eventId: ctx.eventId ?? randomUUID(),
      aggregateId: tx.walletId,
      correlationId: ctx.correlationId,
      causationId: ctx.causationId ?? tx.id,
      occurredAt: ctx.occurredAt ?? rejectedAt,
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
        failureCode: tx.failureCode ?? FailureCode.PermanentInfrastructureFailure,
        rejectedAt: rejectedAt.toISOString(),
      },
    });
  }
}

