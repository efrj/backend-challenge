import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { DocumentBuilder, SwaggerModule } from "@nestjs/swagger";
import { AppModule } from "./app.module";
import { getAppConfig } from "./infrastructure/config/app-config";
import { StructuredLoggerService } from "./infrastructure/observability/structured-logger.service";
import {
  shutdownTelemetry,
  startTelemetry,
} from "./infrastructure/observability/telemetry";

async function bootstrap() {
  await startTelemetry();

  const app = await NestFactory.create(AppModule, {
    logger: false,
  });

  app.enableShutdownHooks();

  const swaggerConfig = new DocumentBuilder()
    .setTitle("Distributed Wagering Processor API")
    .setDescription(
      "Serviço financeiro distribuído de processamento de apostas para provedores de jogos iGaming. Suporta BET, WIN, LOSS, REFUND, ROLLBACK, ledger imutável e reconciliação contábil.",
    )
    .setVersion("1.0.0")
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description: "Token JWT emitido pelo Casdoor (OIDC / OAuth2 RS256)",
      },
      "BearerAuth",
    )
    .addTag("Wallets", "Gerenciamento de carteiras de jogadores e ledger imutável")
    .addTag("Wagering", "Processamento e consultas de transações de apostas")
    .addTag("Observability", "Probes de healthcheck e métricas")
    .build();

  const document = SwaggerModule.createDocument(app, swaggerConfig);
  SwaggerModule.setup("docs", app, document, {
    customSiteTitle: "Wagering Processor API Docs",
    swaggerOptions: {
      persistAuthorization: true,
    },
  });

  const logger = app.get(StructuredLoggerService);
  const config = getAppConfig();

  await app.listen(config.port, "0.0.0.0");
  logger.info("Distributed Wagering Processor listening", {
    port: config.port,
    instanceId: config.instanceId,
    docsUrl: `http://localhost:${config.port}/docs`,
  });

  const handleSignal = async (signal: string) => {
    logger.info(`Received ${signal}; starting graceful shutdown`, { signal });
    await app.close();
    await shutdownTelemetry();
    process.exit(0);
  };

  process.once("SIGTERM", () => void handleSignal("SIGTERM"));
  process.once("SIGINT", () => void handleSignal("SIGINT"));
}

if (import.meta.main) {
  bootstrap().catch((err) => {
    console.error(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        level: "ERROR",
        message: "Fatal error during bootstrap",
        error: err instanceof Error ? err.message : String(err),
      }),
    );
    process.exit(1);
  });
}

