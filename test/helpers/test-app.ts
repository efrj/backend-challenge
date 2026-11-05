import "reflect-metadata";
import { EntityManager, MikroORM } from "@mikro-orm/core";
import { INestApplication } from "@nestjs/common";
import { NestFactory } from "@nestjs/core";
import { Client } from "pg";
import { AppModule } from "../../src/app.module";
import { ReconcileWalletUseCase } from "../../src/application/use-cases/reconcile-wallet.use-case";
import { OutboxPublisherWorker } from "../../src/application/workers/outbox-publisher.worker";
import { PendingReferenceWorker } from "../../src/application/workers/pending-reference.worker";
import { SqsWagerConsumerWorker } from "../../src/application/workers/sqs-wager-consumer.worker";
import { SqsService } from "../../src/infrastructure/messaging/sqs.service";
import { DatabaseMigratorService } from "../../src/infrastructure/persistence/database-migrator.service";
import { WalletRecord } from "../../src/infrastructure/persistence/entities/records";

export interface TestAppInstance {
  app: INestApplication;
  baseUrl: string;
  port: number;
  orm: MikroORM;
  em: EntityManager;
  sqsService: SqsService;
  outboxWorker: OutboxPublisherWorker;
  pendingRefWorker: PendingReferenceWorker;
  sqsConsumerWorker: SqsWagerConsumerWorker;
  reconcileUseCase: ReconcileWalletUseCase;
  close: () => Promise<void>;
}

let testDbInitialized = false;

async function ensureTestDatabaseExists(dbName: string): Promise<void> {
  if (testDbInitialized) return;
  const client = new Client({
    host: process.env.DB_HOST ?? "localhost",
    port: Number(process.env.DB_PORT ?? 5432),
    user: process.env.DB_USER ?? "jungle",
    password: process.env.DB_PASSWORD ?? "jungle_secret",
    database: "postgres",
  });
  await client.connect();
  try {
    const res = await client.query(
      `SELECT 1 FROM pg_database WHERE datname = $1`,
      [dbName],
    );
    if (res.rowCount === 0) {
      await client.query(`CREATE DATABASE "${dbName}"`);
    }
    testDbInitialized = true;
  } finally {
    await client.end();
  }
}

export async function createTestAppInstance(options?: {
  workersEnabled?: boolean;
  instanceId?: string;
}): Promise<TestAppInstance> {
  const testDbName = process.env.TEST_DB_NAME ?? "wagering_test_db";
  await ensureTestDatabaseExists(testDbName);

  process.env.DB_NAME = testDbName;
  process.env.SQS_WAGER_QUEUE_NAME = "wager-transactions-test.fifo";
  process.env.SQS_WAGER_DLQ_NAME = "wager-transactions-dlq-test.fifo";
  process.env.SQS_EVENTS_QUEUE_NAME = "wager-integration-events-test.fifo";
  process.env.LOG_SILENT = process.env.LOG_SILENT ?? "true";
  process.env.WORKERS_ENABLED =
    options?.workersEnabled === true ? "true" : "false";
  process.env.AUTO_MIGRATE = "true";

  const app = await NestFactory.create(AppModule, { logger: false });
  await app.init();
  await app.listen(0, "127.0.0.1");

  const httpServer = app.getHttpServer();
  const address = httpServer.address();
  const port = typeof address === "object" && address ? address.port : 3000;
  const baseUrl = `http://127.0.0.1:${port}`;

  const orm = app.get(MikroORM);
  const migrator = app.get(DatabaseMigratorService);
  await migrator.migrateUp();

  const sqsService = app.get(SqsService);
  await sqsService.ensureQueuesExist();

  return {
    app,
    baseUrl,
    port,
    orm,
    em: orm.em,
    sqsService,
    outboxWorker: app.get(OutboxPublisherWorker),
    pendingRefWorker: app.get(PendingReferenceWorker),
    sqsConsumerWorker: app.get(SqsWagerConsumerWorker),
    reconcileUseCase: app.get(ReconcileWalletUseCase),
    close: async () => {
      await app.close();
    },
  };
}

export async function assertAllWalletsConsistent(
  instance: TestAppInstance,
  walletIds?: string[],
): Promise<void> {
  const fork = instance.em.fork();
  const records = walletIds
    ? await fork.find(WalletRecord, { id: { $in: walletIds } })
    : await fork.find(WalletRecord, {});

  for (const record of records) {
    const report = await instance.reconcileUseCase.execute(record.id);
    if (!report.consistent) {
      throw new Error(
        `Invariant violation for wallet ${record.id}: storedBalance=${report.storedBalance.amount} != calculatedBalance=${report.calculatedBalance.amount} (diff=${report.difference.amount})`,
      );
    }
  }
}
