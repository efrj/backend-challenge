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
  async getTransactionById(@Param("transactionId") transactionId: string) {
    if (!UUID_REGEX.test(transactionId)) {
      throw new InvalidTransactionInputError(
        "transactionId must be a valid UUID",
      );
    }
    return await this.getWagerTransactionUseCase.getById(transactionId);
  }

  @Get("providers/:providerId/wagering/transactions/:externalTransactionId")
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
