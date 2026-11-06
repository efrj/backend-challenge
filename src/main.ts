import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
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

  const logger = app.get(StructuredLoggerService);
  const config = getAppConfig();

  await app.listen(config.port, "0.0.0.0");
  logger.info("Distributed Wagering Processor listening", {
    port: config.port,
    instanceId: config.instanceId,
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

