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
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiQuery,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
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

@ApiTags("Wallets")
@ApiBearerAuth("BearerAuth")
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
  @ApiOperation({
    summary: "Criar carteira para jogador com saldo inicial",
    description:
      "Cria a carteira e gera atomicamente o lançamento inicial de crédito no ledger.",
  })
  @ApiHeader({
    name: "x-correlation-id",
    required: false,
    description: "Identificador de rastreamento distribuído",
  })
  @ApiResponse({ status: 201, description: "Carteira criada com sucesso" })
  @ApiResponse({ status: 400, description: "Dados de entrada inválidos" })
  @ApiResponse({ status: 409, description: "Jogador já possui carteira nesta moeda" })
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
  @ApiOperation({ summary: "Consultar carteira e saldo materializado" })
  @ApiParam({ name: "walletId", description: "UUID da carteira" })
  @ApiResponse({ status: 200, description: "Dados da carteira" })
  @ApiResponse({ status: 404, description: "Carteira não encontrada" })
  async getWallet(@Param("walletId") walletId: string) {
    if (!UUID_REGEX.test(walletId)) {
      throw new InvalidWalletStateError("walletId must be a valid UUID");
    }
    return await this.getWalletUseCase.execute(walletId);
  }

  @Get(":walletId/ledger")
  @ApiOperation({
    summary: "Consultar extrato contábil imutável (Ledger)",
    description: "Paginação via cursor opaco e estável.",
  })
  @ApiParam({ name: "walletId", description: "UUID da carteira" })
  @ApiQuery({ name: "limit", required: false, description: "Quantidade máxima de registros (default: 50)" })
  @ApiQuery({ name: "cursor", required: false, description: "Cursor de paginação retornado no nextCursor anterior" })
  @ApiResponse({ status: 200, description: "Página de lançamentos do ledger" })
  @ApiResponse({ status: 404, description: "Carteira não encontrada" })
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
  @ApiOperation({
    summary: "Executar reconciliação contábil da carteira",
    description:
      "Calcula em tempo real a soma dos lançamentos do ledger com row lock e compara com o saldo persistido, reportando discrepâncias.",
  })
  @ApiParam({ name: "walletId", description: "UUID da carteira" })
  @ApiResponse({ status: 200, description: "Resultado da reconciliação contábil" })
  @ApiResponse({ status: 404, description: "Carteira não encontrada" })
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

