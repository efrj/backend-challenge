import { trace } from "@opentelemetry/api";
import { Injectable } from "@nestjs/common";
import { getAppConfig } from "../config/app-config";

export interface LogContext {
  correlationId?: string;
  messageId?: string;
  transactionId?: string;
  walletId?: string;
  providerId?: string;
  [key: string]: unknown;
}

const REDACTED_KEYS = new Set([
  "password",
  "secret",
  "token",
  "authorization",
  "money",
  "balance",
  "initialBalance",
  "balanceBefore",
  "balanceAfter",
  "storedBalance",
  "calculatedBalance",
  "amount",
  "rawPayload",
]);

@Injectable()
export class StructuredLoggerService {
  private readonly instanceId = getAppConfig().instanceId;
  private readonly silent = getAppConfig().logSilent;

  info(message: string, context: LogContext = {}): void {
    this.write("INFO", message, context);
  }

  warn(message: string, context: LogContext = {}): void {
    this.write("WARN", message, context);
  }

  error(message: string, context: LogContext = {}): void {
    this.write("ERROR", message, context);
  }

  private write(
    level: "INFO" | "WARN" | "ERROR",
    message: string,
    context: LogContext,
  ): void {
    if (this.silent) {
      return;
    }

    const sanitizedContext = this.sanitize(context);
    const spanContext = trace.getActiveSpan()?.spanContext();
    const entry = {
      timestamp: new Date().toISOString(),
      level,
      instanceId: this.instanceId,
      message,
      ...(spanContext ? { traceId: spanContext.traceId, spanId: spanContext.spanId } : {}),
      correlationId: sanitizedContext.correlationId ?? null,
      messageId: sanitizedContext.messageId ?? null,
      transactionId: sanitizedContext.transactionId ?? null,
      walletId: sanitizedContext.walletId ?? null,
      providerId: sanitizedContext.providerId ?? null,
      ...sanitizedContext,
    };

    const serialized = JSON.stringify(entry);
    if (level === "ERROR") {
      process.stderr.write(`${serialized}\n`);
    } else {
      process.stdout.write(`${serialized}\n`);
    }
  }

  private sanitize(obj: Record<string, unknown>): Record<string, unknown> {
    const clean: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(obj)) {
      if (value === undefined) {
        continue;
      }
      if (REDACTED_KEYS.has(key)) {
        clean[key] = "[REDACTED]";
      } else if (
        value !== null &&
        typeof value === "object" &&
        !Array.isArray(value) &&
        !(value instanceof Date)
      ) {
        clean[key] = this.sanitize(value as Record<string, unknown>);
      } else {
        clean[key] = value;
      }
    }
    return clean;
  }
}

