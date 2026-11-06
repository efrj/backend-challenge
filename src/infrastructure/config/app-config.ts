import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Runtime settings come from the process environment.
 *
 * Bun loads `.env` automatically. Outside production, missing keys are filled
 * from `.env.example` without overriding variables that are already set.
 * Docker Compose injects the same names and overrides only what changes inside
 * the compose network (`DB_HOST`, `SQS_ENDPOINT`, `INSTANCE_ID`, `AUTO_MIGRATE`).
 */
export interface AppConfig {
  nodeEnv: string;
  port: number;
  instanceId: string;
  logSilent: boolean;
  authMode: "noop" | "strict";
  autoMigrate: boolean;
  workersEnabled: boolean;
  outboxPollIntervalMs: number;
  pendingRefPollIntervalMs: number;
  pendingRefMaxAttempts: number;
  pendingRefInitialBackoffMs: number;
  db: {
    host: string;
    port: number;
    user: string;
    password: string;
    name: string;
    poolMax: number;
  };
  aws: {
    region: string;
    accessKeyId: string;
    secretAccessKey: string;
  };
  sqs: {
    endpoint: string;
    wagerQueueName: string;
    wagerDlqName: string;
    eventsQueueName: string;
    maxReceiveCount: number;
    visibilityTimeoutSec: number;
  };
  otel: {
    enabled: boolean;
    endpoint: string;
    serviceName: string;
    exportIntervalMs: number;
  };
}

let envFilesLoaded = false;

export function loadEnvFiles(): void {
  if (envFilesLoaded) return;
  envFilesLoaded = true;

  if (process.env.NODE_ENV === "production") return;

  const exampleFile = resolveEnvExamplePath();
  if (!exampleFile) return;

  for (const line of readFileSync(exampleFile, "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const separator = trimmed.indexOf("=");
    if (separator <= 0) continue;

    const key = trimmed.slice(0, separator).trim();
    let value = trimmed.slice(separator + 1).trim();
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1);
    }

    if (process.env[key] === undefined || process.env[key] === "") {
      process.env[key] = value;
    }
  }
}

export function getAppConfig(): AppConfig {
  loadEnvFiles();

  const authMode = required("AUTH_MODE");
  if (authMode !== "noop" && authMode !== "strict") {
    throw new Error(
      `Environment variable AUTH_MODE must be 'noop' or 'strict', received '${authMode}'`,
    );
  }

  return {
    nodeEnv: process.env.NODE_ENV?.trim() || "development",
    port: requiredInt("PORT"),
    instanceId: required("INSTANCE_ID"),
    logSilent: process.env.LOG_SILENT === "true",
    authMode,
    autoMigrate: process.env.AUTO_MIGRATE !== "false",
    workersEnabled: process.env.WORKERS_ENABLED !== "false",
    outboxPollIntervalMs: requiredInt("OUTBOX_POLL_INTERVAL_MS"),
    pendingRefPollIntervalMs: requiredInt("PENDING_REF_POLL_INTERVAL_MS"),
    pendingRefMaxAttempts: requiredInt("PENDING_REF_MAX_ATTEMPTS"),
    pendingRefInitialBackoffMs: requiredInt("PENDING_REF_INITIAL_BACKOFF_MS"),
    db: {
      host: required("DB_HOST"),
      port: requiredInt("DB_PORT"),
      user: required("DB_USER"),
      password: required("DB_PASSWORD"),
      name: required("DB_NAME"),
      poolMax: requiredInt("DB_POOL_MAX"),
    },
    aws: {
      region: required("AWS_REGION"),
      accessKeyId: required("AWS_ACCESS_KEY_ID"),
      secretAccessKey: required("AWS_SECRET_ACCESS_KEY"),
    },
    sqs: {
      endpoint: required("SQS_ENDPOINT"),
      wagerQueueName: required("SQS_WAGER_QUEUE_NAME"),
      wagerDlqName: required("SQS_WAGER_DLQ_NAME"),
      eventsQueueName: required("SQS_EVENTS_QUEUE_NAME"),
      maxReceiveCount: requiredInt("SQS_MAX_RECEIVE_COUNT"),
      visibilityTimeoutSec: requiredInt("SQS_VISIBILITY_TIMEOUT_SEC"),
    },
    otel: {
      enabled: process.env.OTEL_ENABLED === "true",
      endpoint: (
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT ?? "http://localhost:4318"
      ).replace(/\/$/, ""),
      serviceName: process.env.OTEL_SERVICE_NAME?.trim() || "wagering-processor",
      exportIntervalMs: positiveInt(
        process.env.OTEL_EXPORT_INTERVAL_MS,
        5000,
      ),
    },
  };
}

function resolveEnvExamplePath(): string | undefined {
  const candidates = [
    resolve(process.cwd(), ".env.example"),
    resolve(dirname(fileURLToPath(import.meta.url)), "../../../.env.example"),
  ];
  return candidates.find((path) => existsSync(path));
}

function required(name: string): string {
  const value = process.env[name];
  if (value === undefined || value.trim() === "") {
    throw new Error(
      `Missing environment variable ${name}. Define it in .env (see .env.example) or in the Docker Compose service environment.`,
    );
  }
  return value.trim();
}

function requiredInt(name: string): number {
  const raw = required(name);
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) {
    throw new Error(
      `Environment variable ${name} must be a number, received '${raw}'`,
    );
  }
  return parsed;
}

function positiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const parsed = Number(raw);
  if (!Number.isFinite(parsed) || parsed <= 0) return fallback;
  return parsed;
}
