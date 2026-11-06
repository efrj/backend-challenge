# Distributed Wagering Processor — Jungle Gaming Technical Challenge

Serviço financeiro distribuído para processamento de transações de apostas (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`) de múltiplos provedores de jogos, construído com **Bun 1.x**, **TypeScript (strict mode)**, **NestJS**, **MikroORM**, **PostgreSQL 16**, **AWS SQS (LocalStack)** e **Casdoor (IAM / OIDC / OAuth2)**.

As decisões arquiteturais, modelagem de domínio, garantias no schema SQL, estratégia de concorrência, autenticação OIDC/JWKS com Casdoor e resultados do teste de carga estão detalhados em [`ARCHITECTURE.md`](./ARCHITECTURE.md).

---

## 1. Infraestrutura Docker (`infra/`)

Toda a infraestrutura containerizada reside no diretório [`infra/`](./infra):

```
infra/
├── Dockerfile                 # Imagem Bun 1.x da aplicação
├── docker-compose.yaml        # Orquestração: PostgreSQL 16, LocalStack SQS, Casdoor IAM, OTel/Tempo/Prometheus/Grafana e 3 instâncias da API (app-1, app-2, app-3)
├── casdoor/
│   └── init_data.json         # Bootstrap declarativo do Casdoor (organização jungle, certificados RS256, aplicações e usuários provider-a e provider-b)
├── grafana/                   # Provisionamento automático de datasources (Prometheus + Tempo) e dashboard financeiro
├── otel/                      # Configuração do OpenTelemetry Collector
├── prometheus/                # Scrape das 3 instâncias da API e do OTel Collector
├── tempo/                     # Backend de distributed tracing (Grafana Tempo)
├── scripts/
│   └── init-localstack.sh     # Provisionamento automático das filas FIFO e DLQ no LocalStack
└── data/
    ├── postgres/              # Volume mapeado do banco de dados PostgreSQL
    ├── localstack/            # Volume mapeado de estado/storage do LocalStack
    └── casdoor/               # Volume mapeado do banco SQLite (WAL) do Casdoor IAM
```

> **Nota sobre Storage**: O domínio deste desafio utiliza exclusivamente **PostgreSQL** (transacional), **AWS SQS** (mensageria) e **Casdoor** (identidade), não exigindo Object Storage (como S3/RustFS). Todos os volumes persistentes de banco de dados, mensageria e identidade estão mapeados para subdiretórios dentro de `infra/data/`.

Os comandos abaixo rodam na **raiz do repositório**. O `docker-compose.yaml` da raiz inclui `infra/docker-compose.yaml`. O mesmo efeito sai de `docker compose -f infra/docker-compose.yaml ...`.

### Pré-requisitos

- **Docker** e **Docker Compose** v2 (`docker compose`, não o binário antigo `docker-compose`)

O Bun só entra se a API ou os testes forem executados no host. A stack completa sobe sem instalar dependências na máquina.

### Configuração

As variáveis ficam em [`.env.example`](./.env.example). O Compose carrega esse arquivo nos containers da API e, se existir, também o `.env` da raiz (este último prevalece). Dentro da rede, só estes valores mudam em relação ao exemplo: `DB_HOST=postgres`, `SQS_ENDPOINT=http://localstack:4566`, `CASDOOR_ENDPOINT=http://casdoor:8000`, `CASDOOR_JWKS_URL=http://casdoor:8000/.well-known/jwks`, `INSTANCE_ID` e `AUTO_MIGRATE`.

```bash
cp .env.example .env   # opcional; sem este arquivo os defaults do exemplo valem
```

Postgres, LocalStack e Casdoor recebem usuário, senha, banco e nomes de fila pelas mesmas variáveis. Para trocar algum desses valores, edite o `.env` e recrie os containers.

### Subindo toda a stack (3 instâncias + Postgres + LocalStack + Casdoor + Observabilidade)

```bash
docker compose up -d --build
```

O `--build` gera a imagem Bun das três instâncias. Na primeira subida o Postgres, o LocalStack e o Casdoor precisam ficar saudáveis antes das APIs; o Compose já espera esses healthchecks. A `app-2` e a `app-3` só iniciam depois que a `app-1` responde em `/health/ready`.

Os serviços ficam expostos em:

- **Instância 1 (`app-1`)**: `http://localhost:3000`
- **Instância 2 (`app-2`)**: `http://localhost:3001`
- **Instância 3 (`app-3`)**: `http://localhost:3002`
- **Casdoor IAM / OIDC (Web UI & OAuth2 Server)**: `http://localhost:8000` (admin: `admin` / `123`)
- **PostgreSQL**: `localhost:5432`
- **LocalStack (SQS)**: `http://localhost:4566`
- **Grafana**: `http://localhost:3003` (dashboard; acesso anônimo de leitura, admin `admin` / `admin`)
- **Prometheus**: `http://localhost:9090`
- **OTLP HTTP** (collector): `http://localhost:4318`

### Migrations

Na stack completa **não** rode `bun run migration:up`. A `app-1` sobe com `AUTO_MIGRATE=true` e aplica as migrations versionadas na inicialização. A `app-2` e a `app-3` sobem com `AUTO_MIGRATE=false` para não disputar o mesmo schema.

O comando `bun run migration:up` existe só para o fluxo em que a API roda no host (seção 2).

### Healthchecks e logs

`docker compose up -d` devolve o terminal assim que os containers são criados. A API pode ainda estar subindo. Confira o estado e acompanhe a saída:

```bash
# Estado de cada serviço. postgres, localstack, casdoor e app-1 devem chegar em healthy
docker compose ps

# Logs de toda a stack, em tempo real
docker compose logs -f

# Logs de um serviço só
docker compose logs -f app-1
docker compose logs -f casdoor
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

`/health/live` só confirma que o processo está no ar. `/health/ready` consulta PostgreSQL e SQS e devolve `200` quando os dois estão acessíveis. Nenhum dos dois exige autenticação (mesmo com `AUTH_MODE=casdoor`).

### OpenTelemetry e dashboard

A stack sobe o OpenTelemetry Collector, o Tempo, o Prometheus e o Grafana junto com as três APIs. Cada instância exporta traces e métricas em OTLP para `http://otel-collector:4318` (`OTEL_ENABLED=true` só dentro do Compose). Fora do Docker o export fica desligado, a menos que `OTEL_ENABLED=true` no `.env`.

O dashboard em `http://localhost:3003` lê o `/metrics` das três instâncias: transações por status, duplicatas, retries, latência p95, DLQ, conflitos de lock, conflitos de idempotência, divergências de reconciliação, outbox lag e **autenticação/autorização (taxa de sucesso vs. 401 unauthorized e tentativas de violação de tenant 403)**. Os traces (HTTP, consumo SQS e publicação da outbox) ficam no datasource **Tempo**, enriquecidos com atributos de identidade (`caller.provider_id`, `caller.client_id`, `caller.subject`, `caller.authenticated`). O `traceId` sai no log JSON da requisição.

```bash
docker compose logs -f otel-collector
docker compose logs -f grafana
```

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

Os dados do Postgres, do LocalStack e do Casdoor ficam em `infra/data/postgres`, `infra/data/localstack` e `infra/data/casdoor`. `docker compose down` não apaga esses diretórios. Para zerar o banco, as filas e o estado do IdP, pare a stack e apague o conteúdo desses diretórios antes de subir de novo.

---

## 2. Guia Rápido: O que fazer após subir o projeto para ver tudo acontecer?

Após rodar `docker compose up -d --build`, você tem um **cluster distribuído completo** ativo na máquina (3 instâncias da API, PostgreSQL, LocalStack SQS, Casdoor IAM, OpenTelemetry Collector, Tempo, Prometheus e Grafana).

Siga o roteiro prático abaixo para interagir com o sistema e observar todas as garantias financeiras, métricas e traces em tempo real:

### 2.1 Abrir as Interfaces Visuais no Navegador

1. **Dashboard do Grafana**: [`http://localhost:3003`](http://localhost:3003)
   - Acesso anônimo pré-configurado (não exige login).
   - Visualize em tempo real: transações por status, duplicatas, outbox lag, latência p95, taxa de autenticação e tentativas 403.
2. **Console do Casdoor (IAM / OIDC)**: [`http://localhost:8000`](http://localhost:8000)
   - Login: `admin` / Senha: `123`.
   - Inspecione a organização `jungle`, as aplicações dos provedores (`provider-a`, `provider-b`) e o certificado RSA `RS256`.

---

### 2.2 Executar um Fluxo Financeiro Completo via Terminal

Abra um terminal e rode a sequência de comandos abaixo (copie e cole):

```bash
# 1. Criar uma Wallet para um jogador com saldo inicial de R$ 1.000,00
WALLET_RES=$(curl -s -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }')
echo $WALLET_RES | jq .
WALLET_ID=$(echo $WALLET_RES | jq -r '.id')
echo "Carteira Criada: $WALLET_ID"

# 2. Fazer uma Aposta (BET) de R$ 100,00 na Instância 1 (porta 3000)
# O saldo cai atomicamente para R$ 900,00
curl -s -X POST http://localhost:3000/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:tx-bet-100" \
  -d "{
    \"providerId\": \"provider-a\",
    \"externalTransactionId\": \"tx-bet-100\",
    \"playerId\": \"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",
    \"walletId\": \"$WALLET_ID\",
    \"roundId\": \"round-1\",
    \"gameId\": \"fortune-chimp\",
    \"kind\": \"BET\",
    \"money\": { \"amount\": \"100.00\", \"currency\": \"BRL\" }
  }" | jq .

# 3. Testar Idempotência Imediata: Enviar a MESMA aposta na Instância 2 (porta 3001)
# Retorna 200 OK com idempotentReplay: true SEM descontar o saldo novamente!
curl -s -X POST http://localhost:3001/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:tx-bet-100" \
  -d "{
    \"providerId\": \"provider-a\",
    \"externalTransactionId\": \"tx-bet-100\",
    \"playerId\": \"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",
    \"walletId\": \"$WALLET_ID\",
    \"roundId\": \"round-1\",
    \"gameId\": \"fortune-chimp\",
    \"kind\": \"BET\",
    \"money\": { \"amount\": \"100.00\", \"currency\": \"BRL\" }
  }" | jq .

# 4. Registrar um Ganho (WIN) de R$ 250,00 na Instância 3 (porta 3002)
# O saldo sobe para R$ 1.150,00 (900 + 250)
curl -s -X POST http://localhost:3002/wagering/transactions \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:tx-win-250" \
  -d "{
    \"providerId\": \"provider-a\",
    \"externalTransactionId\": \"tx-win-250\",
    \"playerId\": \"0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1\",
    \"walletId\": \"$WALLET_ID\",
    \"roundId\": \"round-1\",
    \"gameId\": \"fortune-chimp\",
    \"kind\": \"WIN\",
    \"money\": { \"amount\": \"250.00\", \"currency\": \"BRL\" }
  }" | jq .

# 5. Auditar o Extrato Imutável (Ledger) da Carteira
# Exibe os 3 lançamentos perfeitamente encadeados e balanceados (OPENING, DEBIT, CREDIT)
curl -s "http://localhost:3000/wallets/$WALLET_ID/ledger" | jq .

# 6. Executar a Reconciliação Contábil da Carteira
# Comprova matematicamente que o saldo armazenado bate 100% com a soma dos lançamentos do ledger
curl -s -X POST "http://localhost:3000/wallets/$WALLET_ID/reconciliation" | jq .
```

---

### 2.3 Ver a Observabilidade Acontecendo em Tempo Real

1. **Dashboard do Grafana (`http://localhost:3003`)**:
   - Os painéis **Transações por status** e **Duplicatas detectadas** refletirão instantaneamente as operações executadas acima.
2. **Distributed Tracing no Tempo**:
   - No Grafana, acesse o menu lateral **Explore** > Datasource **Tempo**.
   - No modo de busca (*Search* ou *TraceQL*), clique em **Run query** para ver a linha do tempo das requisições HTTP e da publicação da outbox para a fila SQS.
   - Abra um trace para auditar a árvore de chamadas, a latência de cada etapa e os atributos de auditoria (`caller.provider_id`, `url.path`, `correlation.id`).
3. **Logs Estruturados**:
   - No terminal, visualize os logs JSON unificados emitidos pelas instâncias:
     ```bash
     docker compose logs -f app-1
     ```

---

### 2.4 Executar o Teste de Carga Automatizado

Para estressar as 3 instâncias em paralelo com 300 requisições simultâneas e disputa de saldo (*hot wallet*):
```bash
bun run test:load
```
O benchmark exibirá throughput (~450 req/s), latências p50/p95 e comprovação de integridade financeira de 100%.

---

## 3. Autenticação e Autorização com Casdoor (OIDC / OAuth2 + JWKS)

### 2.1 Por que escolhemos o Casdoor?

Para a autenticação e autorização dos provedores de jogos (`provider-a`, `provider-b`, etc.), adotamos o **[Casdoor](https://casdoor.org/) (`casbin/casdoor`)** como servidor de identidade OIDC/OAuth2.

O **Casdoor** foi escolhido por atuar como uma espécie de **herdeiro/substituto direto do Keycloak** e por ser **drasticamente mais leve**:

| Característica | Keycloak (Java / Quarkus) | Casdoor (Go / Casbin) |
|---|---|---|
| **Runtime** | JVM (Java) | Binário nativo compilado em **Go** |
| **Consumo de RAM em container** | ~800 MB a >1.5 GB | **~40 MB a 60 MB** |
| **Tempo de boot (Cold Start)** | 30s a 60s+ | **~1.5s a 2s** |
| **Protocolos suportados** | OIDC, OAuth 2.0, SAML, JWKS | **OIDC, OAuth 2.0 (`client_credentials`, `password`, `authorization_code`), SAML, JWKS RS256, Casbin RBAC** |
| **Provisionamento declarativo** | Realm JSON pesado e lento para importar | **`init_data.json` instantâneo no boot** |
| **Interface de Administração** | Web Console | **Web UI moderna e completa (`http://localhost:8000`)** |

Isso permite subir um servidor de identidade OIDC/OAuth2 real junto com as 3 instâncias da API, PostgreSQL, LocalStack e toda a stack de observabilidade sem sobrecarregar a máquina de desenvolvimento ou o ambiente de CI.

### 2.2 Credenciais Pré-Provisionadas (`infra/casdoor/init_data.json`)

Na primeira inicialização, o Casdoor carrega automaticamente o arquivo [`infra/casdoor/init_data.json`](./infra/casdoor/init_data.json) e cria a organização `jungle`, o certificado RSA de 2048 bits (`cert-built-in`, algoritmo `RS256`), duas aplicações OAuth2 e os respectivos usuários dos provedores de jogos:

| Entidade | Identificador / Usuário | Segredo / Senha | `providerId` Mapeado no Token |
|---|---|---|---|
| **Console Web Admin** (`http://localhost:8000`) | `admin` (org: `built-in`) | `123` | *(Operador global — acesso irrestrito)* |
| **App OAuth2 — Provider A** (`client_credentials`) | `client_id`: `provider-a-client-id` | `client_secret`: `provider-a-client-secret` | `provider-a` |
| **App OAuth2 — Provider B** (`client_credentials`) | `client_id`: `provider-b-client-id` | `client_secret`: `provider-b-client-secret` | `provider-b` |
| **Usuário — Provider A** (`password` grant) | `username`: `provider-a` (org: `jungle`) | `password`: `provider-a-secret` | `provider-a` |
| **Usuário — Provider B** (`password` grant) | `username`: `provider-b` (org: `jungle`) | `password`: `provider-b-secret` | `provider-b` |

### 2.3 Modos de Operação (`AUTH_MODE`)

A autenticação é controlada pela variável de ambiente `AUTH_MODE` (lida por `getAppConfig()` e aplicada pelo `ProviderAuthGuard` / `ConfigurableProviderIdentityAdapter`):

1. **`AUTH_MODE=noop` (Padrão em `.env.example`)**:
   - Modo *frictionless* para avaliação rápida e execução imediata de testes de carga/concorrência sem necessidade de anexar tokens em cada chamada.
   - Se o header `Authorization: Bearer <token>` não for enviado, a requisição é aceita como `anonymous-trusted-caller`. Se um JWT for enviado, suas claims (`sub`, `providerId`, `scope`) são decodificadas e anexadas ao contexto da requisição (`req.caller`).
2. **`AUTH_MODE=casdoor` (ou `AUTH_MODE=strict`)**:
   - **Exige** um token JWT válido no header `Authorization: Bearer <token>` em todos os endpoints de `/wallets` e `/wagering/transactions` (retornando `401 Unauthorized` se ausente, expirado ou com assinatura inválida).
   - **Verifica criptograficamente a assinatura `RS256`** do token diretamente nas chaves públicas expostas pelo endpoint JWKS do Casdoor (`GET http://localhost:8000/.well-known/jwks` no host ou `http://casdoor:8000/.well-known/jwks` na rede Docker), utilizando cache em memória das chaves (`jose`).
   - **Impõe Isolamento entre Provedores (*Tenant Isolation*)**: um token emitido para `provider-a` **só pode** submeter ou consultar transações cujo `providerId` seja `"provider-a"`. Qualquer tentativa de enviar ou consultar dados de `"provider-b"` com o token do `"provider-a"` é bloqueada imediatamente pelo `ProviderAuthGuard` com **`403 Forbidden`**.
   - Os endpoints operacionais `/health/live`, `/health/ready` e `/metrics` permanecem abertos para healthchecks do Docker/Kubernetes e coleta do Prometheus.

### 2.4 Passo a Passo: Como Obter um Token no Casdoor e Chamar a API

#### Passo 1: Ativar `AUTH_MODE=casdoor` (opcional se quiser forçar exigência na stack)
No arquivo `.env` na raiz do projeto, defina:
```dotenv
AUTH_MODE=casdoor
```
E aplique nos containers da API:
```bash
docker compose up -d
```

#### Passo 2: Obter um Access Token JWT (`RS256`) no Casdoor

Você pode emitir o token via **`client_credentials`** (recomendado para comunicação *machine-to-machine* entre o servidor do provedor de jogo e o Wagering Processor) ou via **`password` grant**:

**Opção A — `client_credentials` Grant (Provider A):**
```bash
export TOKEN_PROVIDER_A=$(curl -s -X POST http://localhost:8000/api/login/oauth/access_token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=client_credentials" \
  -d "client_id=provider-a-client-id" \
  -d "client_secret=provider-a-client-secret" \
  -d "scope=openid profile wagering:write wagering:read" | jq -r '.access_token')

echo "Token Provider A: $TOKEN_PROVIDER_A"
```

**Opção B — `password` Grant (Provider B):**
```bash
export TOKEN_PROVIDER_B=$(curl -s -X POST http://localhost:8000/api/login/oauth/access_token \
  -H "Content-Type: application/x-www-form-urlencoded" \
  -d "grant_type=password" \
  -d "client_id=provider-b-client-id" \
  -d "client_secret=provider-b-client-secret" \
  -d "username=provider-b" \
  -d "password=provider-b-secret" \
  -d "scope=openid profile wagering:write wagering:read" | jq -r '.access_token')

echo "Token Provider B: $TOKEN_PROVIDER_B"
```

> **Inspecionando o JWKS do Casdoor**:
> ```bash
> curl -s http://localhost:8000/.well-known/jwks | jq .
> ```

#### Passo 3: Chamar os Endpoints Protegidos com o Token

1. **Criar uma Wallet autenticado:**
```bash
curl -X POST http://localhost:3000/wallets \
  -H "Authorization: Bearer $TOKEN_PROVIDER_A" \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

2. **Submeter uma aposta (`BET`) do `provider-a` usando o token do `provider-a` (`200 OK`):**
```bash
curl -X POST http://localhost:3000/wagering/transactions \
  -H "Authorization: Bearer $TOKEN_PROVIDER_A" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: provider-a:tx-auth-001" \
  -d '{
    "providerId": "provider-a",
    "externalTransactionId": "tx-auth-001",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<WALLET_ID>",
    "roundId": "round-100",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
```

3. **Testar o bloqueio de falsificação entre provedores (`403 Forbidden`):**
Se o `provider-a` tentar submeter uma transação em nome do `provider-b`:
```bash
curl -i -X POST http://localhost:3000/wagering/transactions \
  -H "Authorization: Bearer $TOKEN_PROVIDER_A" \
  -H "Content-Type: application/json" \
  -H "Idempotency-Key: spoof-attempt-001" \
  -d '{
    "providerId": "provider-b",
    "externalTransactionId": "tx-spoof-001",
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "walletId": "<WALLET_ID>",
    "roundId": "round-100",
    "gameId": "fortune-chimp",
    "kind": "BET",
    "money": { "amount": "25.00", "currency": "BRL" }
  }'
# Retorna HTTP/1.1 403 Forbidden:
# {"statusCode":403,"message":"Authenticated provider 'provider-a' is not authorized to submit transactions for provider 'provider-b'","error":"Forbidden"}
```

---

## 4. Desenvolvimento Local e Comandos

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

# 3. Subir PostgreSQL, LocalStack e Casdoor em containers
docker compose -f infra/docker-compose.yaml up -d postgres localstack casdoor

# 4. Executar migrations versionadas
bun run migration:up

# (Opcional) Reverter última migration
bun run migration:down

# 5. Iniciar a aplicação localmente
bun run start
```

Esse fluxo sobe só o banco, as filas e o IdP. A API roda no host, então as migrations **não** são aplicadas pela `app-1`. Use `bun run migration:up` aqui. Na stack completa da seção 1 esse comando não é necessário.

---

## 5. Executando os Testes

Os testes de unidade e o `bun run typecheck` não usam Docker. Os testes de **integração**, **concorrência** e o **teste de carga** falam com PostgreSQL 16, LocalStack SQS e Casdoor reais. Suba esses três serviços antes de rodá-los. As três instâncias da API não precisam estar no ar: cada teste sobe os próprios processos NestJS.

```bash
docker compose up -d postgres localstack casdoor
docker compose ps
```

Espere `postgres`, `localstack` e `casdoor` ficarem `healthy` no `docker compose ps`. Se a subida falhar, o detalhe está em `docker compose logs postgres`, `docker compose logs localstack` e `docker compose logs casdoor`.

```bash
# Executar toda a suíte (Unidade + Integração + Concorrência)
bun test

# Apenas testes de unidade (Money, Wallet, WagerTransaction, PayloadHash, Eventos, Auth JWKS RS256, OTel)
bun run test:unit

# Apenas testes de integração (Migrations, Constraints SQL, Trigger de Imutabilidade, API HTTP, Casdoor OAuth2/JWKS E2E, SQS, Inbox, Outbox, DLQ)
bun run test:integration

# Apenas testes de concorrência (50 apostas idênticas em paralelo, disputa 100 BRL vs 2x 80 BRL, >= 3 instâncias, crash antes do ack, 2 publishers na outbox, REFUND/ROLLBACK fora de ordem, restart recovery)
bun run test:concurrency

# Executar o benchmark de teste de carga (diferencial opcional)
bun run test:load

# Checagem estrita de tipos TypeScript
bun run typecheck
```

---

## 6. Endpoints da API HTTP

> **Nota**: Quando `AUTH_MODE=noop` (padrão), o header `Authorization` é opcional. Quando `AUTH_MODE=casdoor` (ou `strict`), inclua `-H "Authorization: Bearer $TOKEN_PROVIDER_A"` nas chamadas abaixo (veja a Seção 2.4).

### 5.1 Criar Wallet
```bash
curl -X POST http://localhost:3000/wallets \
  -H "Content-Type: application/json" \
  -d '{
    "playerId": "0192f28f-5dc0-7d58-bdb2-814ad6a0f4a1",
    "initialBalance": { "amount": "1000.00", "currency": "BRL" }
  }'
```

### 5.2 Submeter Transação de Aposta (`BET`, `WIN`, `LOSS`, `REFUND`, `ROLLBACK`)
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

### 5.3 Consultas e Reconciliação
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

### 5.4 Observabilidade e Health Checks
```bash
# Liveness probe (não requer autenticação)
curl http://localhost:3000/health/live

# Readiness probe — valida conectividade real com PostgreSQL e SQS (não requer autenticação)
curl http://localhost:3000/health/ready

# Métricas no formato Prometheus (não requer autenticação)
curl http://localhost:3000/metrics

# Métricas em snapshot JSON (não requer autenticação)
curl http://localhost:3000/metrics/json
```
