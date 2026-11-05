import { Migration } from "@mikro-orm/migrations";

export class Migration20260101000000_InitialSchema extends Migration {
  override async up(): Promise<void> {
    // 1. Wallets table with non-negativity, version, and unique (player_id, currency) constraints
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "wallets" (
        "id" UUID PRIMARY KEY,
        "player_id" VARCHAR(128) NOT NULL,
        "currency" CHAR(3) NOT NULL,
        "balance_amount" NUMERIC(20, 2) NOT NULL,
        "version" INTEGER NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "updated_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_wallets_player_currency" UNIQUE ("player_id", "currency"),
        CONSTRAINT "chk_wallets_balance_non_negative" CHECK ("balance_amount" >= 0),
        CONSTRAINT "chk_wallets_version_positive" CHECK ("version" >= 1),
        CONSTRAINT "chk_wallets_currency_iso" CHECK ("currency" ~ '^[A-Z]{3}$')
      );
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_wallets_player_id" ON "wallets" ("player_id");
    `);

    // 2. Wager transactions table with idempotency, provider uniqueness, and state/kind checks
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "wager_transactions" (
        "id" UUID PRIMARY KEY,
        "provider_id" VARCHAR(128) NOT NULL,
        "external_transaction_id" VARCHAR(128) NOT NULL,
        "idempotency_key" VARCHAR(255) NOT NULL,
        "payload_hash" CHAR(64) NOT NULL,
        "wallet_id" UUID NOT NULL,
        "player_id" VARCHAR(128) NOT NULL,
        "round_id" VARCHAR(128) NOT NULL,
        "game_id" VARCHAR(128) NOT NULL,
        "kind" VARCHAR(32) NOT NULL,
        "money_amount" NUMERIC(20, 2) NOT NULL,
        "money_currency" CHAR(3) NOT NULL,
        "reference_external_transaction_id" VARCHAR(128) NULL,
        "reference_transaction_id" UUID NULL REFERENCES "wager_transactions" ("id") ON DELETE RESTRICT,
        "status" VARCHAR(32) NOT NULL,
        "failure_code" VARCHAR(64) NULL,
        "observed_balance_amount" NUMERIC(20, 2) NULL,
        "observed_balance_currency" CHAR(3) NULL,
        "retry_count" INTEGER NOT NULL DEFAULT 0,
        "next_retry_at" TIMESTAMPTZ NULL,
        "correlation_id" VARCHAR(128) NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "processed_at" TIMESTAMPTZ NULL,
        CONSTRAINT "uq_wager_tx_idempotency_key" UNIQUE ("idempotency_key"),
        CONSTRAINT "uq_wager_tx_provider_external" UNIQUE ("provider_id", "external_transaction_id"),
        CONSTRAINT "chk_wager_tx_kind" CHECK ("kind" IN ('OPENING', 'BET', 'WIN', 'LOSS', 'REFUND', 'ROLLBACK')),
        CONSTRAINT "chk_wager_tx_status" CHECK ("status" IN ('PENDING', 'PENDING_REFERENCE', 'PROCESSED', 'REJECTED', 'FAILED')),
        CONSTRAINT "chk_wager_tx_money_non_negative" CHECK ("money_amount" >= 0),
        CONSTRAINT "chk_wager_tx_positive_for_financial_kinds" CHECK ("kind" IN ('LOSS', 'OPENING') OR "money_amount" > 0),
        CONSTRAINT "chk_wager_tx_reference_required" CHECK ("kind" NOT IN ('REFUND', 'ROLLBACK') OR "reference_external_transaction_id" IS NOT NULL),
        CONSTRAINT "chk_wager_tx_retry_non_negative" CHECK ("retry_count" >= 0)
      );
    `);

    // Partial unique index guaranteeing at the DB level that a referenced transaction can NEVER be reversed more than once
    this.addSql(`
      CREATE UNIQUE INDEX IF NOT EXISTS "uq_wager_tx_single_reversal_per_reference"
      ON "wager_transactions" ("reference_transaction_id")
      WHERE "status" = 'PROCESSED' AND "kind" IN ('REFUND', 'ROLLBACK') AND "reference_transaction_id" IS NOT NULL;
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_wager_tx_wallet_id" ON "wager_transactions" ("wallet_id");
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_wager_tx_pending_reference"
      ON "wager_transactions" ("next_retry_at", "created_at")
      WHERE "status" = 'PENDING_REFERENCE';
    `);

    // 3. Wallet ledger entries table (append-only, immutable, balanced arithmetic check, 1 entry per wallet+transaction)
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "wallet_ledger_entries" (
        "id" UUID PRIMARY KEY,
        "sequence_num" BIGSERIAL NOT NULL UNIQUE,
        "wallet_id" UUID NOT NULL REFERENCES "wallets" ("id") ON DELETE RESTRICT,
        "transaction_id" UUID NOT NULL REFERENCES "wager_transactions" ("id") ON DELETE RESTRICT,
        "direction" VARCHAR(16) NOT NULL,
        "money_amount" NUMERIC(20, 2) NOT NULL,
        "money_currency" CHAR(3) NOT NULL,
        "balance_before_amount" NUMERIC(20, 2) NOT NULL,
        "balance_after_amount" NUMERIC(20, 2) NOT NULL,
        "created_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT "uq_ledger_wallet_transaction" UNIQUE ("wallet_id", "transaction_id"),
        CONSTRAINT "chk_ledger_direction" CHECK ("direction" IN ('DEBIT', 'CREDIT')),
        CONSTRAINT "chk_ledger_money_positive" CHECK ("money_amount" > 0),
        CONSTRAINT "chk_ledger_balances_non_negative" CHECK ("balance_before_amount" >= 0 AND "balance_after_amount" >= 0),
        CONSTRAINT "chk_ledger_arithmetic_balance" CHECK (
          ("direction" = 'CREDIT' AND "balance_before_amount" + "money_amount" = "balance_after_amount")
          OR
          ("direction" = 'DEBIT' AND "balance_before_amount" - "money_amount" = "balance_after_amount")
        )
      );
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_ledger_wallet_sequence"
      ON "wallet_ledger_entries" ("wallet_id", "sequence_num" ASC);
    `);

    // Database-level immutability trigger: forbid UPDATE and DELETE on wallet_ledger_entries
    this.addSql(`
      CREATE OR REPLACE FUNCTION prevent_ledger_entry_mutation()
      RETURNS TRIGGER AS $$
      BEGIN
        RAISE EXCEPTION 'wallet_ledger_entries is append-only and immutable: % is forbidden', TG_OP
          USING ERRCODE = '55000';
      END;
      $$ LANGUAGE plpgsql;
    `);

    this.addSql(`
      DROP TRIGGER IF EXISTS "trg_prevent_ledger_mutation" ON "wallet_ledger_entries";
      CREATE TRIGGER "trg_prevent_ledger_mutation"
      BEFORE UPDATE OR DELETE ON "wallet_ledger_entries"
      FOR EACH ROW
      EXECUTE FUNCTION prevent_ledger_entry_mutation();
    `);

    // 4. Inbox messages table (persistent consumer deduplication)
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "inbox_messages" (
        "consumer_name" VARCHAR(128) NOT NULL,
        "message_id" VARCHAR(255) NOT NULL,
        "payload_hash" CHAR(64) NOT NULL,
        "received_at" TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        "processed_at" TIMESTAMPTZ NULL,
        PRIMARY KEY ("consumer_name", "message_id")
      );
    `);

    // 5. Outbox messages table (transactional outbox with concurrent polling support)
    this.addSql(`
      CREATE TABLE IF NOT EXISTS "outbox_messages" (
        "id" UUID PRIMARY KEY,
        "aggregate_id" VARCHAR(128) NOT NULL,
        "event_type" VARCHAR(128) NOT NULL,
        "payload" JSONB NOT NULL,
        "occurred_at" TIMESTAMPTZ NOT NULL,
        "attempts" INTEGER NOT NULL DEFAULT 0,
        "next_attempt_at" TIMESTAMPTZ NULL,
        "published_at" TIMESTAMPTZ NULL,
        CONSTRAINT "chk_outbox_attempts_non_negative" CHECK ("attempts" >= 0)
      );
    `);

    this.addSql(`
      CREATE INDEX IF NOT EXISTS "idx_outbox_pending_due"
      ON "outbox_messages" ("next_attempt_at", "occurred_at")
      WHERE "published_at" IS NULL;
    `);
  }

  override async down(): Promise<void> {
    this.addSql(`DROP TABLE IF EXISTS "outbox_messages" CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS "inbox_messages" CASCADE;`);
    this.addSql(`DROP TRIGGER IF EXISTS "trg_prevent_ledger_mutation" ON "wallet_ledger_entries";`);
    this.addSql(`DROP FUNCTION IF EXISTS prevent_ledger_entry_mutation();`);
    this.addSql(`DROP TABLE IF EXISTS "wallet_ledger_entries" CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS "wager_transactions" CASCADE;`);
    this.addSql(`DROP TABLE IF EXISTS "wallets" CASCADE;`);
  }
}

