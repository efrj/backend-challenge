import { Migrator } from "@mikro-orm/migrations";
import { defineConfig, Options } from "@mikro-orm/postgresql";
import { getAppConfig } from "../config/app-config";
import {
  InboxMessageSchema,
  OutboxMessageSchema,
  WagerTransactionSchema,
  WalletLedgerEntrySchema,
  WalletSchema,
} from "./entities/records";
import { Migration20260101000000_InitialSchema } from "./migrations/Migration20260101000000_InitialSchema";

export function createMikroOrmOptions(overrides: Partial<Options> = {}): Options {
  const config = getAppConfig();
  return defineConfig({
    host: config.db.host,
    port: config.db.port,
    user: config.db.user,
    password: config.db.password,
    dbName: config.db.name,
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
      max: config.db.poolMax,
    },
    debug: false,
    ...overrides,
  });
}

export default createMikroOrmOptions();
