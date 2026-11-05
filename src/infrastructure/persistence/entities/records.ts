import { EntitySchema } from "@mikro-orm/core";
import { InboxMessage } from "../../../domain/messaging/inbox-message";
import { OutboxMessage } from "../../../domain/messaging/outbox-message";
import { Money } from "../../../domain/money/money";
import { FailureCode } from "../../../domain/wagering/failure-code";
import {
  WagerTransaction,
  WagerTransactionKind,
  WagerTransactionStatus,
} from "../../../domain/wagering/wager-transaction";
import { Wallet } from "../../../domain/wallet/wallet";
import {
  LedgerDirection,
  WalletLedgerEntry,
} from "../../../domain/wallet/wallet-ledger-entry";

export class WalletRecord {
  id!: string;
  playerId!: string;
  currency!: string;
  balanceAmount!: string;
  version!: number;
  createdAt!: Date;
  updatedAt!: Date;
}

export const WalletSchema = new EntitySchema<WalletRecord>({
  class: WalletRecord,
  tableName: "wallets",
  properties: {
    id: { type: "uuid", primary: true },
    playerId: { type: "string", fieldName: "player_id", length: 128 },
    currency: { type: "string", fieldName: "currency", length: 3 },
    balanceAmount: {
      type: "numeric",
      fieldName: "balance_amount",
      precision: 20,
      scale: 2,
    },
    version: { type: "integer", fieldName: "version" },
    createdAt: { type: "Date", fieldName: "created_at" },
    updatedAt: { type: "Date", fieldName: "updated_at" },
  },
});

export class WagerTransactionRecord {
  id!: string;
  providerId!: string;
  externalTransactionId!: string;
  idempotencyKey!: string;
  payloadHash!: string;
  walletId!: string;
  playerId!: string;
  roundId!: string;
  gameId!: string;
  kind!: string;
  moneyAmount!: string;
  moneyCurrency!: string;
  referenceExternalTransactionId?: string | null;
  referenceTransactionId?: string | null;
  status!: string;
  failureCode?: string | null;
  observedBalanceAmount?: string | null;
  observedBalanceCurrency?: string | null;
  retryCount!: number;
  nextRetryAt?: Date | null;
  correlationId?: string | null;
  createdAt!: Date;
  processedAt?: Date | null;
}

export const WagerTransactionSchema = new EntitySchema<WagerTransactionRecord>({
  class: WagerTransactionRecord,
  tableName: "wager_transactions",
  properties: {
    id: { type: "uuid", primary: true },
    providerId: { type: "string", fieldName: "provider_id", length: 128 },
    externalTransactionId: {
      type: "string",
      fieldName: "external_transaction_id",
      length: 128,
    },
    idempotencyKey: {
      type: "string",
      fieldName: "idempotency_key",
      length: 255,
    },
    payloadHash: { type: "string", fieldName: "payload_hash", length: 64 },
    walletId: { type: "uuid", fieldName: "wallet_id" },
    playerId: { type: "string", fieldName: "player_id", length: 128 },
    roundId: { type: "string", fieldName: "round_id", length: 128 },
    gameId: { type: "string", fieldName: "game_id", length: 128 },
    kind: { type: "string", fieldName: "kind", length: 32 },
    moneyAmount: {
      type: "numeric",
      fieldName: "money_amount",
      precision: 20,
      scale: 2,
    },
    moneyCurrency: { type: "string", fieldName: "money_currency", length: 3 },
    referenceExternalTransactionId: {
      type: "string",
      fieldName: "reference_external_transaction_id",
      length: 128,
      nullable: true,
    },
    referenceTransactionId: {
      type: "uuid",
      fieldName: "reference_transaction_id",
      nullable: true,
    },
    status: { type: "string", fieldName: "status", length: 32 },
    failureCode: {
      type: "string",
      fieldName: "failure_code",
      length: 64,
      nullable: true,
    },
    observedBalanceAmount: {
      type: "numeric",
      fieldName: "observed_balance_amount",
      precision: 20,
      scale: 2,
      nullable: true,
    },
    observedBalanceCurrency: {
      type: "string",
      fieldName: "observed_balance_currency",
      length: 3,
      nullable: true,
    },
    retryCount: { type: "integer", fieldName: "retry_count", default: 0 },
    nextRetryAt: {
      type: "Date",
      fieldName: "next_retry_at",
      nullable: true,
    },
    correlationId: {
      type: "string",
      fieldName: "correlation_id",
      length: 128,
      nullable: true,
    },
    createdAt: { type: "Date", fieldName: "created_at" },
    processedAt: { type: "Date", fieldName: "processed_at", nullable: true },
  },
});

export class WalletLedgerEntryRecord {
  id!: string;
  sequenceNum?: string;
  walletId!: string;
  transactionId!: string;
  direction!: string;
  moneyAmount!: string;
  moneyCurrency!: string;
  balanceBeforeAmount!: string;
  balanceAfterAmount!: string;
  createdAt!: Date;
}

export const WalletLedgerEntrySchema =
  new EntitySchema<WalletLedgerEntryRecord>({
    class: WalletLedgerEntryRecord,
    tableName: "wallet_ledger_entries",
    properties: {
      id: { type: "uuid", primary: true },
      sequenceNum: {
        type: "bigint",
        fieldName: "sequence_num",
        persist: false,
        nullable: true,
      },
      walletId: { type: "uuid", fieldName: "wallet_id" },
      transactionId: { type: "uuid", fieldName: "transaction_id" },
      direction: { type: "string", fieldName: "direction", length: 16 },
      moneyAmount: {
        type: "numeric",
        fieldName: "money_amount",
        precision: 20,
        scale: 2,
      },
      moneyCurrency: { type: "string", fieldName: "money_currency", length: 3 },
      balanceBeforeAmount: {
        type: "numeric",
        fieldName: "balance_before_amount",
        precision: 20,
        scale: 2,
      },
      balanceAfterAmount: {
        type: "numeric",
        fieldName: "balance_after_amount",
        precision: 20,
        scale: 2,
      },
      createdAt: { type: "Date", fieldName: "created_at" },
    },
  });

export class InboxMessageRecord {
  consumerName!: string;
  messageId!: string;
  payloadHash!: string;
  receivedAt!: Date;
  processedAt?: Date | null;
}

export const InboxMessageSchema = new EntitySchema<InboxMessageRecord>({
  class: InboxMessageRecord,
  tableName: "inbox_messages",
  properties: {
    consumerName: {
      type: "string",
      fieldName: "consumer_name",
      length: 128,
      primary: true,
    },
    messageId: {
      type: "string",
      fieldName: "message_id",
      length: 255,
      primary: true,
    },
    payloadHash: { type: "string", fieldName: "payload_hash", length: 64 },
    receivedAt: { type: "Date", fieldName: "received_at" },
    processedAt: { type: "Date", fieldName: "processed_at", nullable: true },
  },
});

export class OutboxMessageRecord {
  id!: string;
  aggregateId!: string;
  eventType!: string;
  payload!: Record<string, unknown>;
  occurredAt!: Date;
  attempts!: number;
  nextAttemptAt?: Date | null;
  publishedAt?: Date | null;
}

export const OutboxMessageSchema = new EntitySchema<OutboxMessageRecord>({
  class: OutboxMessageRecord,
  tableName: "outbox_messages",
  properties: {
    id: { type: "uuid", primary: true },
    aggregateId: { type: "string", fieldName: "aggregate_id", length: 128 },
    eventType: { type: "string", fieldName: "event_type", length: 128 },
    payload: { type: "json", fieldName: "payload" },
    occurredAt: { type: "Date", fieldName: "occurred_at" },
    attempts: { type: "integer", fieldName: "attempts", default: 0 },
    nextAttemptAt: {
      type: "Date",
      fieldName: "next_attempt_at",
      nullable: true,
    },
    publishedAt: { type: "Date", fieldName: "published_at", nullable: true },
  },
});

// ---- Domain <-> Record Mappers ----

export const PersistenceMapper = {
  walletToDomain(record: WalletRecord): Wallet {
    return Wallet.rehydrate({
      id: record.id,
      playerId: record.playerId,
      currency: record.currency,
      balance: Money.rehydrate({
        amount: record.balanceAmount,
        currency: record.currency,
      }),
      version: Number(record.version),
      createdAt: new Date(record.createdAt),
      updatedAt: new Date(record.updatedAt),
    });
  },

  walletToRecord(wallet: Wallet, target = new WalletRecord()): WalletRecord {
    target.id = wallet.id;
    target.playerId = wallet.playerId;
    target.currency = wallet.currency;
    target.balanceAmount = wallet.balance.amount;
    target.version = wallet.version;
    target.createdAt = wallet.createdAt;
    target.updatedAt = wallet.updatedAt;
    return target;
  },

  transactionToDomain(record: WagerTransactionRecord): WagerTransaction {
    return WagerTransaction.rehydrate({
      id: record.id,
      providerId: record.providerId,
      externalTransactionId: record.externalTransactionId,
      idempotencyKey: record.idempotencyKey,
      payloadHash: record.payloadHash,
      walletId: record.walletId,
      playerId: record.playerId,
      roundId: record.roundId,
      gameId: record.gameId,
      kind: record.kind as WagerTransactionKind,
      money: Money.rehydrate({
        amount: record.moneyAmount,
        currency: record.moneyCurrency,
      }),
      referenceExternalTransactionId:
        record.referenceExternalTransactionId ?? undefined,
      referenceTransactionId: record.referenceTransactionId ?? undefined,
      status: record.status as WagerTransactionStatus,
      failureCode: (record.failureCode as FailureCode) ?? undefined,
      observedBalance:
        record.observedBalanceAmount && record.observedBalanceCurrency
          ? Money.rehydrate({
              amount: record.observedBalanceAmount,
              currency: record.observedBalanceCurrency,
            })
          : undefined,
      retryCount: Number(record.retryCount ?? 0),
      nextRetryAt: record.nextRetryAt ? new Date(record.nextRetryAt) : undefined,
      correlationId: record.correlationId ?? undefined,
      createdAt: new Date(record.createdAt),
      processedAt: record.processedAt ? new Date(record.processedAt) : undefined,
    });
  },

  transactionToRecord(
    tx: WagerTransaction,
    target = new WagerTransactionRecord(),
  ): WagerTransactionRecord {
    target.id = tx.id;
    target.providerId = tx.providerId;
    target.externalTransactionId = tx.externalTransactionId;
    target.idempotencyKey = tx.idempotencyKey;
    target.payloadHash = tx.payloadHash;
    target.walletId = tx.walletId;
    target.playerId = tx.playerId;
    target.roundId = tx.roundId;
    target.gameId = tx.gameId;
    target.kind = tx.kind;
    target.moneyAmount = tx.money.amount;
    target.moneyCurrency = tx.money.currency;
    target.referenceExternalTransactionId =
      tx.referenceExternalTransactionId ?? null;
    target.referenceTransactionId = tx.referenceTransactionId ?? null;
    target.status = tx.status;
    target.failureCode = tx.failureCode ?? null;
    target.observedBalanceAmount = tx.observedBalance?.amount ?? null;
    target.observedBalanceCurrency = tx.observedBalance?.currency ?? null;
    target.retryCount = tx.retryCount;
    target.nextRetryAt = tx.nextRetryAt ?? null;
    target.correlationId = tx.correlationId ?? null;
    target.createdAt = tx.createdAt;
    target.processedAt = tx.processedAt ?? null;
    return target;
  },

  ledgerToDomain(record: WalletLedgerEntryRecord): WalletLedgerEntry {
    return WalletLedgerEntry.rehydrate({
      id: record.id,
      walletId: record.walletId,
      transactionId: record.transactionId,
      direction: record.direction as LedgerDirection,
      money: Money.rehydrate({
        amount: record.moneyAmount,
        currency: record.moneyCurrency,
      }),
      balanceBefore: Money.rehydrate({
        amount: record.balanceBeforeAmount,
        currency: record.moneyCurrency,
      }),
      balanceAfter: Money.rehydrate({
        amount: record.balanceAfterAmount,
        currency: record.moneyCurrency,
      }),
      createdAt: new Date(record.createdAt),
    });
  },

  ledgerToRecord(
    entry: WalletLedgerEntry,
    target = new WalletLedgerEntryRecord(),
  ): WalletLedgerEntryRecord {
    target.id = entry.id;
    target.walletId = entry.walletId;
    target.transactionId = entry.transactionId;
    target.direction = entry.direction;
    target.moneyAmount = entry.money.amount;
    target.moneyCurrency = entry.money.currency;
    target.balanceBeforeAmount = entry.balanceBefore.amount;
    target.balanceAfterAmount = entry.balanceAfter.amount;
    target.createdAt = entry.createdAt;
    return target;
  },

  inboxToDomain(record: InboxMessageRecord): InboxMessage {
    return InboxMessage.rehydrate({
      consumerName: record.consumerName,
      messageId: record.messageId,
      payloadHash: record.payloadHash,
      receivedAt: new Date(record.receivedAt),
      processedAt: record.processedAt ? new Date(record.processedAt) : undefined,
    });
  },

  inboxToRecord(
    inbox: InboxMessage,
    target = new InboxMessageRecord(),
  ): InboxMessageRecord {
    target.consumerName = inbox.consumerName;
    target.messageId = inbox.messageId;
    target.payloadHash = inbox.payloadHash;
    target.receivedAt = inbox.receivedAt;
    target.processedAt = inbox.processedAt ?? null;
    return target;
  },

  outboxToDomain(record: OutboxMessageRecord): OutboxMessage {
    return OutboxMessage.rehydrate({
      id: record.id,
      aggregateId: record.aggregateId,
      eventType: record.eventType,
      payload: record.payload,
      occurredAt: new Date(record.occurredAt),
      attempts: Number(record.attempts ?? 0),
      nextAttemptAt: record.nextAttemptAt
        ? new Date(record.nextAttemptAt)
        : undefined,
      publishedAt: record.publishedAt ? new Date(record.publishedAt) : undefined,
    });
  },

  outboxToRecord(
    outbox: OutboxMessage,
    target = new OutboxMessageRecord(),
  ): OutboxMessageRecord {
    target.id = outbox.id;
    target.aggregateId = outbox.aggregateId;
    target.eventType = outbox.eventType;
    target.payload = { ...outbox.payload };
    target.occurredAt = outbox.occurredAt;
    target.attempts = outbox.attempts;
    target.nextAttemptAt = outbox.nextAttemptAt ?? null;
    target.publishedAt = outbox.publishedAt ?? null;
    return target;
  },
};

