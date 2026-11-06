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
      `## Visão Geral
Serviço financeiro distribuído de processamento de transações de apostas (\`BET\`, \`WIN\`, \`LOSS\`, \`REFUND\`, \`ROLLBACK\`) para múltiplos provedores de jogos iGaming.
Garante precisão monetária (\`decimal.js\`), ledger imutável, reconciliação contábil, concorrência por *row-level lock* (\`SELECT ... FOR UPDATE\`) e idempotência persistente em 3 camadas.

---

## 🔐 Autenticação e Autorização (Casdoor OIDC / OAuth2)
O gerenciamento de identidade é realizado pelo **[Casdoor](https://casdoor.org/)** (\`casbin/casdoor\`), escolhido como **herdeiro/substituto direto do Keycloak** por ser **drasticamente mais leve** (desenvolvido em **Go**, consome apenas **~50MB de RAM** e inicia em **~2s**, contra >1GB de RAM e 40s+ do Keycloak na JVM).

### Como autenticar no Swagger:
1. Emita um token JWT assinado (\`RS256\`) no endpoint OAuth2 do Casdoor:
\`\`\`bash
curl -s -X POST http://localhost:8000/api/login/oauth/access_token \\
  -H "Content-Type: application/x-www-form-urlencoded" \\
  -d "grant_type=client_credentials" \\
  -d "client_id=provider-a-client-id" \\
  -d "client_secret=provider-a-client-secret" \\
  -d "scope=openid profile wagering:write wagering:read" | jq -r '.access_token'
\`\`\`
2. Clique no botão verde **Authorize** (topo direito) e cole o token.
3. Todas as requisições subsequentes incluirão o cabeçalho \`Authorization: Bearer <token>\`.

### Credenciais Pré-Provisionadas:
* **Provider A (\`client_credentials\`)**: \`client_id: provider-a-client-id\` / \`client_secret: provider-a-client-secret\` (ProviderId: \`provider-a\`)
* **Provider B (\`client_credentials\`)**: \`client_id: provider-b-client-id\` / \`client_secret: provider-b-client-secret\` (ProviderId: \`provider-b\`)
* **Console Web Casdoor**: [\`http://localhost:8000\`](http://localhost:8000) (Admin: \`admin\` / \`123\`)

### Modos de Operação (\`AUTH_MODE\`):
* **\`AUTH_MODE=noop\`** (Default para desenvolvimento/testes): Permite chamadas anônimas e decodifica tokens se fornecidos.
* **\`AUTH_MODE=casdoor\` / \`strict\`**: Validação criptográfica estrita das assinaturas \`RS256\` via JWKS do Casdoor (\`/.well-known/jwks\`) e **Isolamento de Tenant** (se o token for do \`provider-a\` e tentar enviar \`provider-b\`, a API bloqueia com **\`403 Forbidden\`**).
`,
    )
    .setVersion("1.0.0")
    .addBearerAuth(
      {
        type: "http",
        scheme: "bearer",
        bearerFormat: "JWT",
        description:
          "Cole aqui o Access Token JWT (RS256) obtido via OAuth2 no Casdoor (POST http://localhost:8000/api/login/oauth/access_token)",
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

