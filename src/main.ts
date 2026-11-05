import "reflect-metadata";
import { NestFactory } from "@nestjs/core";
import { AppModule } from "./app.module";
import { StructuredLoggerService } from "./infrastructure/observability/structured-logger.service";

async function bootstrap() {
  const app = await NestFactory.create(AppModule, {
    logger: false,
  });

  app.enableShutdownHooks();

  const logger = app.get(StructuredLoggerService);
  const port = Number(process.env.PORT ?? 3000);

  await app.listen(port, "0.0.0.0");
  logger.info("Distributed Wagering Processor listening", {
    port,
    instanceId: process.env.INSTANCE_ID ?? "app-local",
  });

  const handleSignal = async (signal: string) => {
    logger.info(`Received ${signal}; starting graceful shutdown`, { signal });
    await app.close();
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

