import { MikroOrmModule } from "@mikro-orm/nestjs";
import { Module } from "@nestjs/common";
import { APP_FILTER, APP_INTERCEPTOR } from "@nestjs/core";
import { CreateWalletUseCase } from "./application/use-cases/create-wallet.use-case";
import { GetWagerTransactionUseCase } from "./application/use-cases/get-wager-transaction.use-case";
import { GetWalletLedgerUseCase } from "./application/use-cases/get-wallet-ledger.use-case";
import { GetWalletUseCase } from "./application/use-cases/get-wallet.use-case";
import { ProcessWagerTransactionUseCase } from "./application/use-cases/process-wager-transaction.use-case";
import { ReconcileWalletUseCase } from "./application/use-cases/reconcile-wallet.use-case";
import { OutboxPublisherWorker } from "./application/workers/outbox-publisher.worker";
import { PendingReferenceWorker } from "./application/workers/pending-reference.worker";
import { SqsWagerConsumerWorker } from "./application/workers/sqs-wager-consumer.worker";
import { PROVIDER_IDENTITY_PORT } from "./domain/ports/provider-identity.port";
import {
  ConfigurableProviderIdentityAdapter,
  ProviderAuthGuard,
} from "./infrastructure/auth/auth.guard";
import { SqsService } from "./infrastructure/messaging/sqs.service";
import { MetricsService } from "./infrastructure/observability/metrics.service";
import { StructuredLoggerService } from "./infrastructure/observability/structured-logger.service";
import { DatabaseMigratorService } from "./infrastructure/persistence/database-migrator.service";
import { createMikroOrmOptions } from "./infrastructure/persistence/mikro-orm.config";
import { HealthController } from "./presentation/http/controllers/health.controller";
import { MetricsController } from "./presentation/http/controllers/metrics.controller";
import { WageringController } from "./presentation/http/controllers/wagering.controller";
import { WalletsController } from "./presentation/http/controllers/wallets.controller";
import { GlobalExceptionFilter } from "./presentation/http/filters/global-exception.filter";
import { TracingInterceptor } from "./presentation/http/interceptors/tracing.interceptor";

@Module({
  imports: [
    MikroOrmModule.forRootAsync({
      useFactory: () => createMikroOrmOptions(),
    }),
  ],
  controllers: [
    WalletsController,
    WageringController,
    HealthController,
    MetricsController,
  ],
  providers: [
    StructuredLoggerService,
    MetricsService,
    DatabaseMigratorService,
    SqsService,
    {
      provide: PROVIDER_IDENTITY_PORT,
      useClass: ConfigurableProviderIdentityAdapter,
    },
    ProviderAuthGuard,
    CreateWalletUseCase,
    GetWalletUseCase,
    GetWalletLedgerUseCase,
    GetWagerTransactionUseCase,
    ProcessWagerTransactionUseCase,
    ReconcileWalletUseCase,
    OutboxPublisherWorker,
    PendingReferenceWorker,
    SqsWagerConsumerWorker,
    {
      provide: APP_FILTER,
      useClass: GlobalExceptionFilter,
    },
    {
      provide: APP_INTERCEPTOR,
      useClass: TracingInterceptor,
    },
  ],
  exports: [
    StructuredLoggerService,
    MetricsService,
    DatabaseMigratorService,
    SqsService,
    CreateWalletUseCase,
    GetWalletUseCase,
    GetWalletLedgerUseCase,
    GetWagerTransactionUseCase,
    ProcessWagerTransactionUseCase,
    ReconcileWalletUseCase,
    OutboxPublisherWorker,
    PendingReferenceWorker,
    SqsWagerConsumerWorker,
  ],
})
export class AppModule {}
