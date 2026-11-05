import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { EntityNotFoundError } from "../../domain/errors/domain-errors";
import { MoneyProps } from "../../domain/money/money";
import { FailureCode } from "../../domain/wagering/failure-code";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../domain/wagering/wager-transaction";
import {
  PersistenceMapper,
  WagerTransactionRecord,
} from "../../infrastructure/persistence/entities/records";

export interface WagerTransactionDto {
  id: string;
  providerId: string;
  externalTransactionId: string;
  idempotencyKey: string;
  walletId: string;
  playerId: string;
  roundId: string;
  gameId: string;
  kind: WagerTransactionKind;
  status: WagerTransactionStatus;
  money: MoneyProps;
  referenceExternalTransactionId?: string;
  referenceTransactionId?: string;
  failureCode?: FailureCode;
  balance?: MoneyProps;
  createdAt: string;
  processedAt?: string;
}

@Injectable()
export class GetWagerTransactionUseCase {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async getById(transactionId: string): Promise<WagerTransactionDto> {
    const fork = this.em.fork();
    const record = await fork.findOne(WagerTransactionRecord, {
      id: transactionId,
    });
    if (!record) {
      throw new EntityNotFoundError("WagerTransaction", transactionId);
    }
    return this.toDto(record);
  }

  async getByProviderAndExternalId(
    providerId: string,
    externalTransactionId: string,
  ): Promise<WagerTransactionDto> {
    const fork = this.em.fork();
    const record = await fork.findOne(WagerTransactionRecord, {
      providerId,
      externalTransactionId,
    });
    if (!record) {
      throw new EntityNotFoundError(
        "WagerTransaction",
        `${providerId}:${externalTransactionId}`,
      );
    }
    return this.toDto(record);
  }

  private toDto(record: WagerTransactionRecord): WagerTransactionDto {
    const tx = PersistenceMapper.transactionToDomain(record);
    return {
      id: tx.id,
      providerId: tx.providerId,
      externalTransactionId: tx.externalTransactionId,
      idempotencyKey: tx.idempotencyKey,
      walletId: tx.walletId,
      playerId: tx.playerId,
      roundId: tx.roundId,
      gameId: tx.gameId,
      kind: tx.kind,
      status: tx.status,
      money: tx.money.toJSON(),
      referenceExternalTransactionId: tx.referenceExternalTransactionId,
      referenceTransactionId: tx.referenceTransactionId,
      failureCode: tx.failureCode,
      balance: tx.observedBalance?.toJSON(),
      createdAt: tx.createdAt.toISOString(),
      processedAt: tx.processedAt?.toISOString(),
    };
  }
}

