import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, Options } from "@mikro-orm/postgresql";
import {
  InboxMessageSchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  WalletSchema,
} from "./entities/records";
import { Migration20260101000000_InitialSchema } from "./migrations/Migration20260101000000_InitialSchema";

export function createMikroOrmOptions(overrides: Partial<Options> = {}): Options {
  return defineConfig({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? "jungle",
    password: process.env.DB_PASSWORD ?? "jungle_secret",
    dbName: process.env.DB_NAME ?? "wagering_db",
    entities: [
      WalletSchema,
      WagerTransactionSchema,
      WalletLedgerEntrySchema,
      InboxMessageSchema,
      OutboxMessageSchema,
    ],
    extensions: [Migrator],
    migrations: {
      migrationsList: [
        {
          name: "Migration20260101000000_InitialSchema",
          class: Migration20260101000000_InitialSchema,
        },
      ],
      transactional: true,
      allOrNothing: true,
    },
    pool: {
      min: 1,
      max: Number(process.env.DB_POOL_MAX ?? 15),
    },
    debug: false,
    ...overrides,
  });
}

export default createMikroOrmOptions();
