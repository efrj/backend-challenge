import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import {
  assertAllWalletsConsistent,
  createTestAppInstance,
  TestAppInstance,
} from "../helpers/test-app";

describe("Integration — Migrations & Database-Level Invariant Constraints", () => {
  let instance: TestAppInstance;

  beforeAll(async () => {
    instance = await createTestAppInstance({ workersEnabled: false });
  });

  afterAll(async () => {
    await assertAllWalletsConsistent(instance);
    await instance.close();
  });

  it("enforces non-negative wallet balance, positive version, and unique (player_id, currency) at the SQL schema level", async () => {
    const conn = instance.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();

    // Valid insert
    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 100.00, 1)`,
      [walletId, playerId],
    );

    // Insert corresponding opening tx & ledger entry so global invariant remains balanced
    const openingTxId = randomUUID();
    await conn.execute(
      `INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
      ) VALUES (?, 'system', ?, ?, ?, ?, ?, 'opening', 'opening', 'OPENING', 100.00, 'BRL', 'PROCESSED')`,
      [
        openingTxId,
        `open-${walletId}`,
        `sys:open-${walletId}`,
        "a".repeat(64),
        walletId,
        playerId,
      ],
    );

    await conn.execute(
      `INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, money_amount, money_currency,
        balance_before_amount, balance_after_amount
      ) VALUES (?, ?, ?, 'CREDIT', 100.00, 'BRL', 0.00, 100.00)`,
      [randomUUID(), walletId, openingTxId],
    );

    // Duplicate (player_id, currency) rejected by DB unique constraint
    await expect(
      conn.execute(
        `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
         VALUES (?, ?, 'BRL', 50.00, 1)`,
        [randomUUID(), playerId],
      ),
    ).rejects.toThrow();

    // Negative balance rejected by DB check constraint
    await expect(
      conn.execute(
        `UPDATE wallets SET balance_amount = -0.01 WHERE id = ?`,
        [walletId],
      ),
    ).rejects.toThrow();

    // Version < 1 rejected by DB check constraint
    await expect(
      conn.execute(`UPDATE wallets SET version = 0 WHERE id = ?`, [walletId]),
    ).rejects.toThrow();
  });

  it("enforces ledger immutability (forbids UPDATE and DELETE) and balanced arithmetic check in PostgreSQL", async () => {
    const conn = instance.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();
    const txId = randomUUID();
    const ledgerId = randomUUID();

    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 50.00, 1)`,
      [walletId, playerId],
    );

    await conn.execute(
      `INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
      ) VALUES (?, 'system', ?, ?, ?, ?, ?, 'r-1', 'g-1', 'OPENING', 50.00, 'BRL', 'PROCESSED')`,
      [
        txId,
        `open-${walletId}`,
        `sys:open-${walletId}`,
        "b".repeat(64),
        walletId,
        playerId,
      ],
    );

    // Unbalanced ledger entry (0 + 50 != 60) rejected by chk_ledger_arithmetic_balance
    await expect(
      conn.execute(
        `INSERT INTO wallet_ledger_entries (
          id, wallet_id, transaction_id, direction, money_amount, money_currency,
          balance_before_amount, balance_after_amount
        ) VALUES (?, ?, ?, 'CREDIT', 50.00, 'BRL', 0.00, 60.00)`,
        [ledgerId, walletId, txId],
      ),
    ).rejects.toThrow();

    // Valid balanced ledger entry
    await conn.execute(
      `INSERT INTO wallet_ledger_entries (
        id, wallet_id, transaction_id, direction, money_amount, money_currency,
        balance_before_amount, balance_after_amount
      ) VALUES (?, ?, ?, 'CREDIT', 50.00, 'BRL', 0.00, 50.00)`,
      [ledgerId, walletId, txId],
    );

    // Duplicate ledger entry for the same (wallet_id, transaction_id) rejected by uq_ledger_wallet_transaction
    await expect(
      conn.execute(
        `INSERT INTO wallet_ledger_entries (
          id, wallet_id, transaction_id, direction, money_amount, money_currency,
          balance_before_amount, balance_after_amount
        ) VALUES (?, ?, ?, 'CREDIT', 50.00, 'BRL', 0.00, 50.00)`,
        [randomUUID(), walletId, txId],
      ),
    ).rejects.toThrow();

    // UPDATE on wallet_ledger_entries is forbidden by trigger trg_prevent_ledger_mutation
    await expect(
      conn.execute(
        `UPDATE wallet_ledger_entries SET money_amount = 99.00 WHERE id = ?`,
        [ledgerId],
      ),
    ).rejects.toThrow(/append-only and immutable/);

    // DELETE on wallet_ledger_entries is forbidden by trigger trg_prevent_ledger_mutation
    await expect(
      conn.execute(`DELETE FROM wallet_ledger_entries WHERE id = ?`, [
        ledgerId,
      ]),
    ).rejects.toThrow(/append-only and immutable/);
  });

  it("enforces partial unique index preventing a referenced transaction from being reversed twice when PROCESSED", async () => {
    const conn = instance.em.getConnection();
    const walletId = randomUUID();
    const playerId = randomUUID();
    const betTxId = randomUUID();

    await conn.execute(
      `INSERT INTO wallets (id, player_id, currency, balance_amount, version)
       VALUES (?, ?, 'BRL', 0.00, 1)`,
      [walletId, playerId],
    );

    await conn.execute(
      `INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency, status
      ) VALUES (?, 'prov-1', ?, ?, ?, ?, ?, 'r-1', 'g-1', 'BET', 20.00, 'BRL', 'PROCESSED')`,
      [
        betTxId,
        `bet-${betTxId}`,
        `prov-1:bet-${betTxId}`,
        "c".repeat(64),
        walletId,
        playerId,
      ],
    );

    // First PROCESSED REFUND referencing betTxId succeeds
    const refund1Id = randomUUID();
    await conn.execute(
      `INSERT INTO wager_transactions (
        id, provider_id, external_transaction_id, idempotency_key, payload_hash,
        wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
        reference_external_transaction_id, reference_transaction_id, status
      ) VALUES (?, 'prov-1', ?, ?, ?, ?, ?, 'r-1', 'g-1', 'REFUND', 20.00, 'BRL', ?, ?, 'PROCESSED')`,
      [
        refund1Id,
        `ref1-${betTxId}`,
        `prov-1:ref1-${betTxId}`,
        "d".repeat(64),
        walletId,
        playerId,
        `bet-${betTxId}`,
        betTxId,
      ],
    );

    // Second PROCESSED REFUND or ROLLBACK referencing the same betTxId is blocked by uq_wager_tx_single_reversal_per_reference
    await expect(
      conn.execute(
        `INSERT INTO wager_transactions (
          id, provider_id, external_transaction_id, idempotency_key, payload_hash,
          wallet_id, player_id, round_id, game_id, kind, money_amount, money_currency,
          reference_external_transaction_id, reference_transaction_id, status
        ) VALUES (?, 'prov-1', ?, ?, ?, ?, ?, 'r-1', 'g-1', 'REFUND', 20.00, 'BRL', ?, ?, 'PROCESSED')`,
        [
          randomUUID(),
          `ref2-${betTxId}`,
          `prov-1:ref2-${betTxId}`,
          "e".repeat(64),
          walletId,
          playerId,
          `bet-${betTxId}`,
          betTxId,
        ],
      ),
    ).rejects.toThrow();
  });
});

