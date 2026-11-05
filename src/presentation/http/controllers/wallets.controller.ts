import {
  Body,
  Controller,
  Get,
  Headers,
  HttpCode,
  HttpStatus,
  Inject,
  Param,
  Post,
  Query,
  UseGuards,
} from "@nestjs/common";
import { randomUUID } from "crypto";
import { CreateWalletUseCase } from "../../../application/use-cases/create-wallet.use-case";
import { GetWalletLedgerUseCase } from "../../../application/use-cases/get-wallet-ledger.use-case";
import { GetWalletUseCase } from "../../../application/use-cases/get-wallet.use-case";
import { ReconcileWalletUseCase } from "../../../application/use-cases/reconcile-wallet.use-case";
import { InvalidWalletStateError } from "../../../domain/errors/domain-errors";
import { MoneyProps } from "../../../domain/money/money";
import { ProviderAuthGuard } from "../../../infrastructure/auth/auth.guard";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Controller("wallets")
@UseGuards(ProviderAuthGuard)
export class WalletsController {
  constructor(
    @Inject(CreateWalletUseCase)
    private readonly createWalletUseCase: CreateWalletUseCase,
    @Inject(GetWalletUseCase)
    private readonly getWalletUseCase: GetWalletUseCase,
    @Inject(GetWalletLedgerUseCase)
    private readonly getWalletLedgerUseCase: GetWalletLedgerUseCase,
    @Inject(ReconcileWalletUseCase)
    private readonly reconcileWalletUseCase: ReconcileWalletUseCase,
  ) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  async createWallet(
    @Body()
    body: {
      playerId?: string;
      initialBalance?: MoneyProps;
    },
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    if (!body || typeof body !== "object") {
      throw new InvalidWalletStateError("Request body is required");
    }
    if (!body.playerId || typeof body.playerId !== "string") {
      throw new InvalidWalletStateError("playerId is required");
    }
    if (!body.initialBalance || typeof body.initialBalance !== "object") {
      throw new InvalidWalletStateError("initialBalance is required");
    }

    return await this.createWalletUseCase.execute({
      playerId: body.playerId,
      initialBalance: body.initialBalance,
      correlationId: correlationId ?? randomUUID(),
    });
  }

  @Get(":walletId")
  async getWallet(@Param("walletId") walletId: string) {
    if (!UUID_REGEX.test(walletId)) {
      throw new InvalidWalletStateError("walletId must be a valid UUID");
    }
    return await this.getWalletUseCase.execute(walletId);
  }

  @Get(":walletId/ledger")
  async getWalletLedger(
    @Param("walletId") walletId: string,
    @Query("cursor") cursor?: string,
    @Query("limit") limit?: string,
  ) {
    if (!UUID_REGEX.test(walletId)) {
      throw new InvalidWalletStateError("walletId must be a valid UUID");
    }
    const parsedLimit = limit !== undefined ? Number(limit) : 50;
    if (Number.isNaN(parsedLimit) || parsedLimit <= 0) {
      throw new InvalidWalletStateError("limit must be a positive integer");
    }

    return await this.getWalletLedgerUseCase.execute({
      walletId,
      cursor,
      limit: parsedLimit,
    });
  }

  @Post(":walletId/reconciliation")
  @HttpCode(HttpStatus.OK)
  async reconcileWallet(
    @Param("walletId") walletId: string,
    @Headers("x-correlation-id") correlationId?: string,
  ) {
    if (!UUID_REGEX.test(walletId)) {
      throw new InvalidWalletStateError("walletId must be a valid UUID");
    }
    return await this.reconcileWalletUseCase.execute(
      walletId,
      correlationId ?? randomUUID(),
    );
  }
}

