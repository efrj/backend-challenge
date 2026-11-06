import {
  Body,
  Controller,
  Get,
  Headers,
  HttpStatus,
  Inject,
  Param,
  Post,
  Res,
  UseGuards,
} from "@nestjs/common";
import {
  ApiBearerAuth,
  ApiHeader,
  ApiOperation,
  ApiParam,
  ApiResponse,
  ApiTags,
} from "@nestjs/swagger";
import { randomUUID } from "crypto";
import type { Response } from "express";
import { GetWagerTransactionUseCase } from "../../../application/use-cases/get-wager-transaction.use-case";
import { ProcessWagerTransactionUseCase } from "../../../application/use-cases/process-wager-transaction.use-case";
import { InvalidTransactionInputError } from "../../../domain/errors/domain-errors";
import { MoneyProps } from "../../../domain/money/money";
import {
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wagering/wager-transaction";
import { ProviderAuthGuard } from "../../../infrastructure/auth/auth.guard";

const UUID_REGEX =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@ApiTags("Wagering")
@ApiBearerAuth("BearerAuth")
@Controller()
@UseGuards(ProviderAuthGuard)
export class WageringController {
  constructor(
    @Inject(ProcessWagerTransactionUseCase)
    private readonly processWagerUseCase: ProcessWagerTransactionUseCase,
    @Inject(GetWagerTransactionUseCase)
    private readonly getWagerTransactionUseCase: GetWagerTransactionUseCase,
  ) {}

  @Post("wagering/transactions")
  @ApiOperation({
    summary: "Submeter transação de aposta (BET, WIN, LOSS, REFUND, ROLLBACK)",
    description:
      "Processa atomicamente uma aposta com controle de concorrência por wallet, dedup persistente em 3 camadas e outbox transacional. Requer cabeçalho Idempotency-Key.",
  })
  @ApiHeader({
    name: "idempotency-key",
    required: true,
    description: "Chave única de idempotência do provedor (ex.: provider-a:tx-100)",
  })
  @ApiHeader({
    name: "x-correlation-id",
    required: false,
    description: "Identificador de rastreamento distribuído da chamada",
  })
  @ApiResponse({
    status: 200,
    description: "Transação confirmada (PROCESSED) ou replay idempotente",
  })
  @ApiResponse({
    status: 202,
    description: "Transação aceita em fila de dependência (PENDING_REFERENCE)",
  })
  @ApiResponse({
    status: 400,
    description: "Dados de entrada inválidos ou cabeçalho ausente",
  })
  @ApiResponse({
    status: 401,
    description: "Token Ausente ou Inválido (quando AUTH_MODE=casdoor)",
  })
  @ApiResponse({
    status: 403,
    description: "Provedor autenticado não autorizado a operar em nome de outro (violação de tenant)",
  })
  @ApiResponse({
    status: 409,
    description: "Conflito de idempotência: chave já usada com payload divergente",
  })
  @ApiResponse({
    status: 422,
    description: "Rejeitado por regra de negócio (saldo insuficiente, moeda incompatível, etc.)",
  })
  async submitTransaction(
    @Headers("idempotency-key") idempotencyKey: string | undefined,
    @Headers("x-correlation-id") correlationId: string | undefined,
    @Body()
    body: {
      providerId?: string;
      externalTransactionId?: string;
      playerId?: string;
      walletId?: string;
      roundId?: string;
      gameId?: string;
      kind?: WagerTransactionKind;
      money?: MoneyProps;
      referenceExternalTransactionId?: string;
    },
    @Res() res: Response,
  ) {
    if (!idempotencyKey || idempotencyKey.trim() === "") {
      throw new InvalidTransactionInputError(
        "Header 'Idempotency-Key' is required",
      );
    }

    if (!body || typeof body !== "object") {
      throw new InvalidTransactionInputError("Request body is required");
    }

    const result = await this.processWagerUseCase.execute({
      idempotencyKey: idempotencyKey.trim(),
      providerId: body.providerId ?? "",
      externalTransactionId: body.externalTransactionId ?? "",
      playerId: body.playerId ?? "",
      walletId: body.walletId ?? "",
      roundId: body.roundId ?? "",
      gameId: body.gameId ?? "",
      kind: body.kind as WagerTransactionKind,
      money: body.money as MoneyProps,
      referenceExternalTransactionId: body.referenceExternalTransactionId,
      correlationId: correlationId ?? randomUUID(),
    });

    const responsePayload: Record<string, unknown> = {
      transactionId: result.transactionId,
      status: result.status,
      balance: result.balance,
      idempotentReplay: result.idempotentReplay,
    };

    if (result.failureCode) {
      responsePayload.failureCode = result.failureCode;
    }

    // Distinct HTTP status codes per Section 9:
    // - 200 OK: PROCESSED (including idempotent replay of PROCESSED)
    // - 202 Accepted: PENDING_REFERENCE (accepted, awaiting referenced transaction)
    // - 422 Unprocessable Entity: REJECTED by business rule (carries failureCode + observed balance)
    if (result.status === WagerTransactionStatus.PendingReference) {
      res.status(HttpStatus.ACCEPTED).json(responsePayload);
      return;
    }

    if (result.status === WagerTransactionStatus.Rejected) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).json(responsePayload);
      return;
    }

    res.status(HttpStatus.OK).json(responsePayload);
  }

  @Get("wagering/transactions/:transactionId")
  @ApiOperation({
    summary: "Consultar transação pelo ID interno (UUID)",
  })
  @ApiParam({
    name: "transactionId",
    description: "UUID interno gerado na criação da transação",
  })
  @ApiResponse({ status: 200, description: "Detalhes da transação" })
  @ApiResponse({ status: 404, description: "Transação não encontrada" })
  async getTransactionById(@Param("transactionId") transactionId: string) {
    if (!UUID_REGEX.test(transactionId)) {
      throw new InvalidTransactionInputError(
        "transactionId must be a valid UUID",
      );
    }
    return await this.getWagerTransactionUseCase.getById(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
  @ApiOperation({
    summary: "Consultar transação por provedor e ID externo",
  })
  @ApiParam({
    name: "providerId",
    description: "Identificador do provedor (ex.: provider-a)",
  })
  @ApiParam({
    name: "externalTransactionId",
    description: "ID de transação fornecido pelo provedor",
  })
  @ApiResponse({ status: 200, description: "Detalhes da transação" })
  @ApiResponse({ status: 403, description: "Provedor autenticado não autorizado a ler recursos de outro" })
  @ApiResponse({ status: 404, description: "Transação não encontrada" })
  async getTransactionByProviderAndExternalId(
    @Param("providerId") providerId: string,
    @Param("externalTransactionId") externalTransactionId: string,
  ) {
    return await this.getWagerTransactionUseCase.getByProviderAndExternalId(
      providerId,
      externalTransactionId,
    );
  }
}
