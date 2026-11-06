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

Os comandos abaixo rodam na **raiz do repositório**. O `docker-compose.yaml` da raiz inclui `infra/docker-compose.yaml`. O mesmo efeito sai de `docker compose -f infra/docker-compose.yaml ...`.

### Pré-requisitos

- **Docker** e **Docker Compose** v2 (`docker compose`, não o binário antigo `docker-compose`)

O Bun só entra se a API ou os testes forem executados no host. A stack completa sobe sem instalar dependências na máquina.

### Configuração

As variáveis ficam em [`.env.example`](./.env.example). O Compose carrega esse arquivo nos containers da API e, se existir, também o `.env` da raiz (este último prevalece). Dentro da rede, só estes valores mudam em relação ao exemplo: `DB_HOST=postgres`, `SQS_ENDPOINT=http://localstack:4566`, `INSTANCE_ID` e `AUTO_MIGRATE`.

```bash
cp .env.example .env   # opcional; sem este arquivo os defaults do exemplo valem
```

Postgres e LocalStack recebem usuário, senha, banco e nomes de fila pelas mesmas variáveis. Para trocar algum desses valores, edite o `.env` e recrie os containers.

### Subindo toda a stack (3 instâncias + Postgres + LocalStack)

```bash
docker compose up -d --build
```

O `--build` gera a imagem Bun das três instâncias. Na primeira subida o Postgres e o LocalStack precisam ficar saudáveis antes das APIs; o Compose já espera esses healthchecks. A `app-2` e a `app-3` só iniciam depois que a `app-1` responde em `/health/ready`.

As instâncias ficam expostas em:

- **Instância 1 (`app-1`)**: `http://localhost:3000`
- **Instância 2 (`app-2`)**: `http://localhost:3001`
- **Instância 3 (`app-3`)**: `http://localhost:3002`
- **PostgreSQL**: `localhost:5432`
- **LocalStack (SQS)**: `http://localhost:4566`

### Migrations

Na stack completa **não** rode `bun run migration:up`. A `app-1` sobe com `AUTO_MIGRATE=true` e aplica as migrations versionadas na inicialização. A `app-2` e a `app-3` sobem com `AUTO_MIGRATE=false` para não disputar o mesmo schema.

O comando `bun run migration:up` existe só para o fluxo em que a API roda no host (seção 2).

### Healthchecks e logs

`docker compose up -d` devolve o terminal assim que os containers são criados. A API pode ainda estar subindo. Confira o estado e acompanhe a saída:

```bash
# Estado de cada serviço. postgres, localstack e app-1 devem chegar em healthy
docker compose ps

# Logs de toda a stack, em tempo real
docker compose logs -f

# Logs de um serviço só
docker compose logs -f app-1
docker compose logs -f postgres
docker compose logs -f localstack
```

Saia do acompanhamento de logs com `Ctrl+C`. Isso não para os containers.

Quando a `app-1` estiver `healthy`, as três instâncias respondem:

```bash
curl http://localhost:3000/health/live
curl http://localhost:3000/health/ready
curl http://localhost:3001/health/ready
curl http://localhost:3002/health/ready
```

`/health/live` só confirma que o processo está no ar. `/health/ready` consulta PostgreSQL e SQS e devolve `200` quando os dois estão acessíveis. Nenhum dos dois exige autenticação.

### Parar e recriar os containers

```bash
# Para os containers e mantém a configuração para um próximo start
docker compose stop

# Sobe de novo os containers já criados, sem rebuild
docker compose start

# Remove containers e a rede do projeto. Os dados em infra/data/ permanecem
docker compose down

# Recria a stack e reconstrói a imagem da API depois de mudar código ou o .env
docker compose up -d --build

# Recria os containers mesmo sem mudança detectada na imagem
docker compose up -d --build --force-recreate
```

Os dados do Postgres e do LocalStack ficam em `infra/data/postgres` e `infra/data/localstack`. `docker compose down` não apaga esses diretórios. Para zerar o banco e as filas, pare a stack e apague o conteúdo desses diretórios antes de subir de novo.

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

Esse fluxo sobe só o banco e as filas. A API roda no host, então as migrations **não** são aplicadas pela `app-1`. Use `bun run migration:up` aqui. Na stack completa da seção 1 esse comando não é necessário.

---

## 3. Executando os Testes

Os testes de unidade e o `bun run typecheck` não usam Docker. Os testes de **integração**, **concorrência** e o **teste de carga** falam com PostgreSQL 16 e LocalStack SQS reais. Suba esses dois serviços antes de rodá-los. As três instâncias da API não precisam estar no ar: cada teste sobe os próprios processos NestJS.

```bash
docker compose up -d postgres localstack
docker compose ps
```

Espere `postgres` e `localstack` ficarem `healthy` no `docker compose ps`. Se a subida falhar, o detalhe está em `docker compose logs postgres` e `docker compose logs localstack`.

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
