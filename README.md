# Distributed Wagering Processor — Jungle Gaming Technical Challenge

Serviço financeiro distribuído para processamento de transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores de jogos, construído com **Bun 1.x**, **TypeScript (strict mode)**, **NestJS**, **MikroORM**, **PostgreSQL 16** e **AWS SQS (LocalStack)**.

As decisões arquiteturais, modelagem de domínio, garantias no schema SQL, estratégia de concorrência e resultados do teste de carga estão detalhados em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 1. Infraestrutura Docker (`infra/`)

Toda a infraestrutura containerizada reside no diretório [`infra/`](./infra):

```
infra/
├── Dockerfile                 # Imagem Bun 1.x da aplicação
├── docker-compose.yaml        # Orquestração: PostgreSQL 16, LocalStack SQS e 3 instâncias da API (app-1, app-2, app-3)
├── scripts/
│   └── init-localstack.sh     # Provisionamento automático das filas FIFO e DLQ no LocalStack
└── data/
    ├── postgres/              # Volume mapeado do banco de dados PostgreSQL
    └── localstack/            # Volume mapeado de estado/storage do LocalStack
```

> **Nota sobre Storage**: O domínio deste desafio utiliza exclusivamente **PostgreSQL** (transacional) e **AWS SQS** (mensageria), não exigindo Object Storage (como S3/RustFS). Todos os volumes persistentes de banco de dados e mensageria estão mapeados para subdiretórios dentro de `infra/data/`.

### Subindo toda a stack com Docker Compose (3 instâncias + Postgres + LocalStack)

```bash
docker compose -f infra/docker-compose.yaml up -d --build
```
*(Ou simplesmente `docker compose up -d --build` na raiz do projeto, que inclui `infra/docker-compose.yaml`).*

As 3 instâncias da aplicação ficam expostas em:
- **Instância 1 (`app-1`)**: `http://localhost:3000`
- **Instância 2 (`app-2`)**: `http://localhost:3001`
- **Instância 3 (`app-3`)**: `http://localhost:3002`

---

## 2. Desenvolvimento Local e Comandos

### Pré-requisitos
- **Docker** & **Docker Compose**
- **Bun 1.x** (`>= 1.1`)

### Configuração

As variáveis ficam em [`.env.example`](./.env.example). Nada de host, senha ou nome de fila fica fixo no código da aplicação: `getAppConfig()` lê o ambiente do processo.

```bash
cp .env.example .env
```

O Bun carrega `.env` sozinho. Se o arquivo não existir e `NODE_ENV` não for `production`, os valores que faltarem são preenchidos a partir de `.env.example`.

O Compose injeta o mesmo arquivo nos containers e sobrescreve só o que muda dentro da rede: `DB_HOST=postgres`, `SQS_ENDPOINT=http://localstack:4566`, `INSTANCE_ID` e `AUTO_MIGRATE` (apenas `app-1` migra). Postgres e LocalStack usam as mesmas variáveis, com default igual ao exemplo quando não há `.env`. Para trocar usuário, senha ou fila, edite `.env` e suba a stack de novo.

### Instalação e Setup Local

```bash
# 1. Instalar dependências
bun install

# 2. Configuração local (opcional se for usar só os defaults de .env.example)
cp .env.example .env

# 3. Subir PostgreSQL e LocalStack em containers
docker compose -f infra/docker-compose.yaml up -d postgres localstack

# 4. Executar migrations versionadas
bun run migration:up

# (Opcional) Reverter última migration
bun run migration:down

# 5. Iniciar a aplicação localmente
bun run start
```

---

## 3. Executando os Testes

Todos os testes de integração e concorrência rodam contra instâncias **reais** do PostgreSQL 16 e do LocalStack SQS em containers Docker (sem substituir o banco ou filas por mocks):

```bash
# Executar toda a suíte (Unidade + Integração + Concorrência)
bun test

# Apenas testes de unidade (Money, Wallet, WagerTransaction, PayloadHash, Eventos)
bun run test:unit

# Apenas testes de integração (Migrations, Constraints SQL, Trigger de Imutabilidade, API HTTP, SQS, Inbox, Outbox, DLQ)
bun run test:integration

# Apenas testes de concorrência (50 apostas idênticas em paralelo, disputa 100 BRL vs 2x 80 BRL, >= 3 instâncias, crash antes do ack, 2 publishers na outbox, REFUND/ROLLBACK fora de ordem, restart recovery)
bun run test:concurrency

# Executar o benchmark de teste de carga (diferencial opcional)
bun run test:load

# Checagem estrita de tipos TypeScript
bun run typecheck
```

---

## 4. Endpoints da API HTTP

### 4.1 Criar Wallet
```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

### 4.2 Submeter Transação de Aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:transaction-123" \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "transaction-123",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<WALLET_ID>",
    "roundId": "round-987",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

### 4.3 Consultas e Reconciliação
```bash
# Consultar saldo e versão da wallet
curl http://localhost:3000/wallets/<WALLET_ID>

# Consultar lançamentos do ledger (paginação por cursor opaco e estável)
curl "http://localhost:3000/wallets/<WALLET_ID>/ledger?limit=50"

# Consultar transação pelo ID interno
curl http://localhost:3000/wagering/transactions/<TRANSACTION_ID>

# Consultar transação pelo provedor + ID externo
curl http://localhost:3000/providers/provider-a/wagering/transactions/transaction-123

# Executar reconciliação contábil (saldo materializado vs. reconstruído pelo ledger)
curl -X POST http://localhost:3000/wallets/<WALLET_ID>/reconciliation
```

### 4.4 Observabilidade e Health Checks
```bash
# Liveness probe (não requer autenticação)
curl http://localhost:3000/health/live

# Readiness probe — valida conectividade real com PostgreSQL e SQS (não requer autenticação)
curl http://localhost:3000/health/ready

# Métricas no formato Prometheus
curl http://localhost:3000/metrics

# Métricas em snapshot JSON
curl http://localhost:3000/metrics/json
```
