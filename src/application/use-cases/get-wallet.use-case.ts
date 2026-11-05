import { EntityManager } from "@mikro-orm/postgresql";
import { Inject, Injectable } from "@nestjs/common";
import { EntityNotFoundError } from "../../domain/errors/domain-errors";
import { MoneyProps } from "../../domain/money/money";
import {
  PersistenceMapper,
  WalletRecord,
} from "../../infrastructure/persistence/entities/records";

export interface GetWalletOutput {
  id: string;
  playerId: string;
  currency: string;
  balance: MoneyProps;
  version: number;
  createdAt: string;
  updatedAt: string;
}

@Injectable()
export class GetWalletUseCase {
  constructor(@Inject(EntityManager) private readonly em: EntityManager) {}

  async execute(walletId: string): Promise<GetWalletOutput> {
    const fork = this.em.fork();
    const record = await fork.findOne(WalletRecord, { id: walletId });
    if (!record) {
      throw new EntityNotFoundError("Wallet", walletId);
    }

    const wallet = PersistenceMapper.walletToDomain(record);
    return {
      id: wallet.id,
      playerId: wallet.playerId,
      currency: wallet.currency,
      balance: wallet.balance.toJSON(),
      version: wallet.version,
      createdAt: wallet.createdAt.toISOString(),
      updatedAt: wallet.updatedAt.toISOString(),
    };
  }
}

