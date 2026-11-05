import type { ArgumentsHost, ExceptionFilter } from "@nestjs/common";
import {
  Catch,
  HttpException,
  HttpStatus,
  Inject,
} from "@nestjs/common";
import type { Request, Response } from "express";
import {
  BusinessRejectionError,
  CurrencyMismatchError,
  DuplicateWalletError,
  EntityNotFoundError,
  IdempotencyConflictError,
  InvalidLedgerEntryError,
  InvalidMoneyError,
  InvalidTransactionInputError,
  InvalidTransactionStateError,
  InvalidWalletStateError,
  TransientInfrastructureError,
} from "../../../domain/errors/domain-errors";
import { StructuredLoggerService } from "../../../infrastructure/observability/structured-logger.service";

@Catch()
export class GlobalExceptionFilter implements ExceptionFilter {
  constructor(
    @Inject(StructuredLoggerService)
    private readonly logger: StructuredLoggerService,
  ) {}

  catch(exception: unknown, host: ArgumentsHost): void {
    const ctx = host.switchToHttp();
    const res = ctx.getResponse<Response>();
    const req = ctx.getRequest<Request>();
    const correlationId =
      (req.headers["x-correlation-id"] as string | undefined) ?? undefined;

    if (exception instanceof BusinessRejectionError) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        transactionId: exception.transactionId,
        status: "REJECTED",
        failureCode: exception.code,
        balance: exception.balance,
        idempotentReplay: exception.idempotentReplay,
        message: exception.message,
      });
      return;
    }

    if (
      exception instanceof InvalidMoneyError ||
      exception instanceof InvalidTransactionInputError ||
      exception instanceof InvalidWalletStateError ||
      exception instanceof InvalidLedgerEntryError ||
      exception instanceof InvalidTransactionStateError
    ) {
      res.status(HttpStatus.BAD_REQUEST).json({
        error: "BAD_REQUEST",
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof CurrencyMismatchError) {
      res.status(HttpStatus.UNPROCESSABLE_ENTITY).json({
        error: "UNPROCESSABLE_ENTITY",
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    if (
      exception instanceof IdempotencyConflictError ||
      exception instanceof DuplicateWalletError
    ) {
      res.status(HttpStatus.CONFLICT).json({
        error: "CONFLICT",
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof EntityNotFoundError) {
      res.status(HttpStatus.NOT_FOUND).json({
        error: "NOT_FOUND",
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof TransientInfrastructureError) {
      this.logger.error("Transient infrastructure error on HTTP request", {
        correlationId,
        path: req.url,
        error: exception.message,
      });
      res.status(HttpStatus.SERVICE_UNAVAILABLE).json({
        error: "SERVICE_UNAVAILABLE",
        code: exception.code,
        message: exception.message,
      });
      return;
    }

    if (exception instanceof HttpException) {
      const status = exception.getStatus();
      const responseBody = exception.getResponse();
      res.status(status).json(
        typeof responseBody === "object"
          ? responseBody
          : {
              error: HttpStatus[status] ?? "HTTP_ERROR",
              message: String(responseBody),
            },
      );
      return;
    }

    this.logger.error("Unhandled exception in HTTP pipeline", {
      correlationId,
      path: req.url,
      error: exception instanceof Error ? exception.message : String(exception),
    });

    res.status(HttpStatus.INTERNAL_SERVER_ERROR).json({
      error: "INTERNAL_SERVER_ERROR",
      code: "INTERNAL_SERVER_ERROR",
      message: "An unexpected internal error occurred",
    });
  }
}
