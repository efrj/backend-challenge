import { createHash } from "crypto";

export interface WagerBusinessPayload {
  providerId: string;
  externalTransactionId: string;
  playerId: string;
  walletId: string;
  roundId: string;
  gameId: string;
  kind: string;
  money: {
    amount: string;
    currency: string;
  };
  referenceExternalTransactionId?: string | null;
}

/**
 * Produces a deterministic canonical JSON string with lexicographically sorted keys.
 * Undefined and null optional fields are normalized out so transport differences do not affect the hash.
 */
export function canonicalizeJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }

  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalizeJson(item)).join(",")}]`;
  }

  const record = value as Record<string, unknown>;
  const sortedKeys = Object.keys(record)
    .filter((key) => record[key] !== undefined && record[key] !== null)
    .sort();

  const entries = sortedKeys.map(
    (key) => `${JSON.stringify(key)}:${canonicalizeJson(record[key])}`,
  );

  return `{${entries.join(",")}}`;
}

/**
 * Computes the SHA-256 hex digest of the canonical business payload.
 * Transport metadata (headers, messageId, occurredAt, correlationId) are excluded.
 */
export function computeWagerPayloadHash(payload: WagerBusinessPayload): string {
  const canonicalPayload: Record<string, unknown> = {
    externalTransactionId: payload.externalTransactionId,
    gameId: payload.gameId,
    kind: payload.kind,
    money: {
      amount: payload.money.amount,
      currency: payload.money.currency,
    },
    playerId: payload.playerId,
    providerId: payload.providerId,
    roundId: payload.roundId,
    walletId: payload.walletId,
  };

  if (
    payload.referenceExternalTransactionId !== undefined &&
    payload.referenceExternalTransactionId !== null &&
    payload.referenceExternalTransactionId !== ""
  ) {
    canonicalPayload.referenceExternalTransactionId =
      payload.referenceExternalTransactionId;
  }

  const canonicalString = canonicalizeJson(canonicalPayload);
  return createHash("sha256").update(canonicalString, "utf8").digest("hex");
}

