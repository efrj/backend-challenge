# Architecture & Engineering Decisions — Distributed Wagering Processor

## 1. Visão Arquitetural

O **Distributed Wagering Processor** foi projetado seguindo princípios de **Domain-Driven Design (DDD)**, **Clean / Hexagonal Architecture** e **Transactional Outbox / Persistent Inbox**, garantindo correção financeira estrita sob entrega *at-least-once*, mensagens fora de ordem e alta concorrência entre múltiplas instâncias.

```
src/
├── domain/                  # Núcleo puro (sem dependências de ORM ou NestJS)
│   ├── money/               # Value Object imutável Money (decimal.js, escala fixa 2)
│   ├── wallet/              # Aggregate Root Wallet + entidade imutável WalletLedgerEntry
│   ├── wagering/            # WagerTransaction, FailureCode, hash canônico SHA-256
│   ├── messaging/           # InboxMessage e OutboxMessage
│   ├── events/              # IntegrationEvent<T> e subclasses tipadas (versionadas)
│   ├── ports/               # ProviderIdentityPort (extensibilidade OIDC/IdP)
│   └── errors/              # Hierarquia de erros de domínio
├── application/             # Casos de uso transacionais e workers assíncronos
│   ├── use-cases/           # CreateWallet, ProcessWagerTransaction, ReconcileWallet, Queries
│   └── workers/             # SqsWagerConsumerWorker, OutboxPublisherWorker, PendingReferenceWorker
├── infrastructure/          # Adaptadores concretos (MikroORM PostgreSQL, AWS SQS, Auth, Logs/Métricas)
│   ├── persistence/         # EntitySchemas desacoplados, PersistenceMapper (.rehydrate), Migrations
│   ├── messaging/           # SqsService (FIFO, RedrivePolicy, DLQ, VisibilityTimeout)
│   ├── observability/       # StructuredLoggerService (JSON c/ redaction) e MetricsService (Prometheus/JSON)
│   └── auth/                # ProviderAuthGuard e ConfigurableProviderIdentityAdapter
└── presentation/            # Controllers HTTP NestJS e GlobalExceptionFilter
```

---

## 2. Escolha do ORM, Mapeamento de `Money` e Estratégia Transacional

### 2.1 Por que MikroORM?
Escolhemos o **MikroORM (`@mikro-orm/postgresql`)** pelos seguintes motivos técnicos:
1. **Separação total entre Domínio e Persistência (`EntitySchema` + `rehydrate`)**: As classes de domínio (`Money`, `Wallet`, `WagerTransaction`, `WalletLedgerEntry`, `InboxMessage`, `OutboxMessage`) possuem construtores `private` e factories estáticas (`create`, `open`, `from`, `rehydrate`), sem nenhum decorator de ORM ou do NestJS (atendendo à restrição 6.1). O MikroORM mapeia registros planos (`WalletRecord`, etc.) via `EntitySchema`, e o `PersistenceMapper` converte de/para o domínio via `.rehydrate()`.
2. **Controle explícito de Transação e Locks (`em.transactional` + `LockMode`)**: Permite adquirir *row-level locks* (`LockMode.PESSIMISTIC_WRITE` / `SELECT ... FOR UPDATE` e `LockMode.PESSIMISTIC_READ`) dentro de um Unit of Work isolado (`em.fork()`), garantindo atomicidade entre `wallets`, `wager_transactions`, `wallet_ledger_entries`, `inbox_messages` e `outbox_messages`.

### 2.2 Representação e Persistência de `Money`
- **Em memória (Domínio)**: Representado pela classe imutável `Money` (`Object.freeze`), encapsulando `Decimal` (`decimal.js`) e `currency` (`ISO-4217`). Nunca utiliza `number`, `float` ou `double`.
- **Validação na fronteira (`Money.from`)**: Rejeita `NaN`, `Infinity`, notação científica (`1e2`), strings vazias, espaços, valores negativos em contratos de entrada e mais de 2 casas decimais. Arredondamento interno utiliza `ROUND_HALF_EVEN` (arredondamento bancário) com escala fixa de 2 casas decimais (`toFixed(2)`).
- **No PostgreSQL**: Armazenado em colunas separadas de precisão exata `NUMERIC(20, 2)` e `CHAR(3)`. O driver `pg` entrega `NUMERIC` como `string`, evitando qualquer conversão intermediária por ponto flutuante IEEE-754.

---

## 3. Garantias no Schema do Banco de Dados (Seção 5, Regra 9)

As invariantes financeiras **não** dependem apenas de código de aplicação; todas são impostas diretamente pelo PostgreSQL na migration reversível `Migration20260101000000_InitialSchema`:

1. **Unicidade de Wallet por Jogador e Moeda**:
   - `CONSTRAINT uq_wallets_player_currency UNIQUE (player_id, currency)`
2. **Não-negatividade de Saldo e Versão Positiva**:
   - `CONSTRAINT chk_wallets_balance_non_negative CHECK (balance_amount >= 0)`
   - `CONSTRAINT chk_wallets_version_positive CHECK (version >= 1)`
3. **Idempotência Persistente e Unicidade por Provedor**:
   - `CONSTRAINT uq_wager_tx_idempotency_key UNIQUE (idempotency_key)`
   - `CONSTRAINT uq_wager_tx_provider_external UNIQUE (provider_id, external_transaction_id)`
   - `PRIMARY KEY (consumer_name, message_id)` na tabela `inbox_messages`.
4. **Proibição de Dupla Reversão no Banco (Partial Unique Index)**:
   - `CREATE UNIQUE INDEX uq_wager_tx_single_reversal_per_reference ON wager_transactions (reference_transaction_id) WHERE status = 'PROCESSED' AND kind IN ('REFUND', 'ROLLBACK') AND reference_transaction_id IS NOT NULL;`
   - Impede estruturalmente que uma mesma transação de referência seja revertida mais de uma vez com status `PROCESSED`.
5. **Consistência Aritmética e Unicidade do Ledger**:
   - `CONSTRAINT uq_ledger_wallet_transaction UNIQUE (wallet_id, transaction_id)` (no máximo 1 lançamento por wallet + transação).
   - `CONSTRAINT chk_ledger_arithmetic_balance CHECK ((direction = 'CREDIT' AND balance_before_amount + money_amount = balance_after_amount) OR (direction = 'DEBIT' AND balance_before_amount - money_amount = balance_after_amount))`
6. **Imutabilidade Estrita do Ledger (Trigger PostgreSQL)**:
   - A trigger `trg_prevent_ledger_mutation` (`BEFORE UPDATE OR DELETE ON wallet_ledger_entries`) aborta com erro `SQLSTATE 55000` qualquer tentativa de `UPDATE` ou `DELETE` em lançamentos do ledger.

---

## 4. Concorrência, Hot Wallet e Idempotência em 3 Camadas

A **unidade de concorrência é a `walletId`**. Não há lock global: wallets distintas são processadas em total paralelismo.

### 4.1 Estratégia de Controle de Concorrência por Wallet
Adotamos **Pessimistic Write Locking por linha de Wallet (`SELECT ... FOR UPDATE`)** aliado ao controle de versão (`version` incrementado a cada alteração de saldo) e retentativa automática para conflitos transitórios de serialização/deadlock (`40001`, `40P01`, `55P03`):
- Em cenários de *hot wallet* (ex.: 50 requisições concorrentes para a mesma carteira ou duas apostas de `80.00 BRL` disputando `100.00 BRL`), o lock otimista puro causaria uma tempestade de abortos (`OptimisticLockError`) sob alta contenção.
- Com `SELECT ... FOR UPDATE` na linha da `walletId`, o próprio PostgreSQL enfileira as transações concorrentes daquela mesma carteira na ordem de chegada em sub-milissegundos, enquanto outras carteiras continuam livres.
- A coluna `version` inicia em `1` na abertura da wallet e incrementa estritamente quando o saldo muda (`DEBIT` ou `CREDIT`).

### 4.2 Idempotência Persistente em 3 Camadas e `payloadHash` Canônico
O `payloadHash` é calculado via **SHA-256** sobre a representação **JSON canônica** (chaves ordenadas lexicograficamente) exclusivamente dos campos de negócio (`providerId`, `externalTransactionId`, `playerId`, `walletId`, `roundId`, `gameId`, `kind`, `money`, `referenceExternalTransactionId`), ignorando headers HTTP, `messageId` ou timestamps de transporte.

Para suportar **50 envios paralelos da mesma aposta** em múltiplas instâncias sem erro 500 e sem duplicar débitos:
1. **Camada 1 (Fast Pre-Check)**: Antes de adquirir lock na wallet, verifica se `idempotency_key` ou `(provider_id, external_transaction_id)` já está persistida. Se sim, valida `matchesPayload(payloadHash)` (lançando `409 Conflict` se divergir ou retornando o resultado original com `idempotentReplay: true` e o `observedBalance` da época).
2. **Camada 2 (Post-Lock Re-Check)**: Após adquirir `SELECT ... FOR UPDATE` na `Wallet`, verifica **novamente** a existência da transação. As 49 requisições concorrentes que aguardavam na fila do lock da wallet enxergam imediatamente a transação confirmada pela 1ª requisição vencedora e retornam `200 OK` com `idempotentReplay: true`.
3. **Camada 3 (Recovery de `23505 unique_violation`)**: Caso duas requisições com a mesma `Idempotency-Key` apontem para `walletId`s distintos e colidam no índice único do banco, o handler captura o código `23505`, consulta o registro vencedor e aplica a mesma regra de replay ou conflito `409`.

---

## 5. Máquina de Estados, Referências Fora de Ordem e Taxonomia de Falhas

### 5.1 Estados e Transições de `WagerTransaction`
```
                  ┌──────────────────────┐
                  │       PENDING        │ (estado inicial em memória)
                  └──────────┬───────────┘
         ┌───────────────────┼───────────────────┐
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌────────────────────┐
│    PROCESSED    │ │    REJECTED     │ │ PENDING_REFERENCE  │
│   (terminal)    │ │   (terminal)    │ │ (aguardando ref.)  │
└─────────────────┘ └─────────────────┘ └─────────┬──────────┘
                                                  │
                                       ┌──────────┴──────────┐
                                       ▼                     ▼
                              ┌─────────────────┐   ┌─────────────────┐
                              │    PROCESSED    │   │    REJECTED     │
                              │   (terminal)    │   │   (terminal)    │
                              └─────────────────┘   └─────────────────┘
```
- `PROCESSED`, `REJECTED` e `FAILED` são **terminais**: qualquer tentativa de transição a partir deles lança `InvalidTransactionStateError`.
- Uma referência `PROCESSED` aceita **uma** reversão, seja `REFUND` ou `ROLLBACK`. O índice parcial `uq_wager_tx_single_reversal_per_reference` e o `failureCode` `ALREADY_REVERSED` tratam os dois kinds como a mesma reversão financeira, para não creditar a aposta duas vezes. Mensagens SQS permanentemente inválidas vão para a DLQ sem linha `FAILED`: não há transação persistida para auditar.
- **Referências fora de ordem (`PENDING_REFERENCE`)**: Quando um `REFUND` ou `ROLLBACK` chega antes da transação referenciada (`BET`/`WIN`/`REFUND`), ele é persistido como `PENDING_REFERENCE` (emitindo `WagerTransactionPendingReference` na outbox). O `PendingReferenceWorker` reprocessa periodicamente os registros devidos com **backoff exponencial** ($200\text{ms} \times 2^{\text{attempt}}$) até `PENDING_REF_MAX_ATTEMPTS` (default: 5). Se a referência chegar nesse intervalo, a reversão é aplicada; se esgotar o limite, transiciona para `REJECTED` com `failureCode = REFERENCE_NOT_FOUND` e publica `WagerTransactionRejected`.

### 5.2 Taxonomia de `FailureCode` e Mapeamento HTTP
| `FailureCode` | Significado Operacional | Status HTTP | Ação Recomendada ao Provedor |
|---|---|---|---|
| `INSUFFICIENT_FUNDS` | Saldo insuficiente na wallet para `BET` | `422` | Não reenviar; informar jogador |
| `REVERSAL_INSUFFICIENT_FUNDS` | `ROLLBACK` de `WIN`/`REFUND` deixaria saldo negativo (Regra 9) | `422` | Não reenviar; abrir disputa operacional |
| `CURRENCY_MISMATCH` | Moeda da operação difere da moeda da wallet | `422` | Corrigir configuração de moeda |
| `WALLET_PLAYER_MISMATCH` | `playerId` informado não pertence à `walletId` | `422` | Corrigir roteamento de carteira |
| `INVALID_REFERENCE_KIND` | `REFUND` apontando para não-`BET` ou `ROLLBACK` inválido | `422` | Não reenviar |
| `REFERENCE_CONTEXT_MISMATCH` | Referência pertence a outro provider, player, wallet ou round | `422` | Não reenviar |
| `REFERENCE_AMOUNT_MISMATCH` | Valor do `REFUND`/`ROLLBACK` difere do valor original | `422` | Corrigir valor para reversão integral |
| `ALREADY_REVERSED` | Transação referenciada já foi revertida anteriormente | `422` | Não reenviar |
| `REFERENCE_NOT_PROCESSED` | Transação referenciada terminou como `REJECTED` ou `FAILED` | `422` | Não reenviar |
| `REFERENCE_NOT_FOUND` | Referência nunca chegou após todas as tentativas de backoff | `422` | Verificar se a transação original existiu |

Outros códigos HTTP padronizados:
- `200 OK`: Transação `PROCESSED` (incluindo replay idempotente).
- `201 Created`: Wallet criada com sucesso.
- `202 Accepted`: Transação aceita em `PENDING_REFERENCE`.
- `400 Bad Request`: Payload malformado, `Money` inválido, `Idempotency-Key` ausente ou `kind = OPENING`.
- `404 Not Found`: Wallet ou transação inexistente.
- `409 Conflict`: Conflito de idempotência (mesma key com payload divergente) ou wallet duplicada.
- `503 Service Unavailable`: Falha transitória de infraestrutura (ex.: banco ou SQS indisponível).

---

## 6. Processamento SQS, Inbox Persistente, Outbox Concorrente e DLQ

1. **Consumidor SQS (`SqsWagerConsumerWorker`)**:
   - Consome `wager-transactions.fifo`, reutiliza `ProcessWagerTransactionUseCase`, grava `InboxMessage` na mesma transação SQL e executa `DeleteMessage` (`ack`) **somente após o commit**.
   - Se o worker morrer após o commit e antes do `ack`, a mensagem reentregue pelo SQS é interceptada pela `inbox_messages` / `idempotency_key` sem duplicar efeitos.
   - Erros permanentes de contrato vão para `wager-transactions-dlq.fifo`; erros transitórios usam `ChangeMessageVisibility` com backoff exponencial até `SQS_MAX_RECEIVE_COUNT` (default: 3), quando são movidos para a DLQ.
   - No `SIGTERM`, interrompe o polling, aguarda o término das mensagens em voo e devolve a visibilidade (`VisibilityTimeout = 0`) caso alguma não termine a tempo.
2. **Transactional Outbox (`OutboxPublisherWorker`)**:
   - Utiliza `SELECT ... FROM outbox_messages WHERE published_at IS NULL AND (next_attempt_at IS NULL OR next_attempt_at <= NOW()) ORDER BY occurred_at ASC LIMIT 25 FOR UPDATE SKIP LOCKED`.
   - O `SELECT` e os `UPDATE` passam o `transactionContext` do MikroORM para `Connection.execute`. Sem isso o driver abre outra conexão em autocommit, o `FOR UPDATE` é liberado antes do publish e dois publishers podem reclamar a mesma linha.
   - Permite múltiplos publishers concorrentes em diferentes instâncias sem contenção nem perda de eventos, publicando na fila FIFO `wager-integration-events.fifo` com `MessageDeduplicationId = eventId` e `MessageGroupId = aggregateId`.

---

## 7. Autenticação (Seção 2)

Conforme permitido pela Seção 2, priorizamos 100% do foco em correção financeira, concorrência, idempotência e resiliência, deixando a porta de autenticação explícita no domínio (`ProviderIdentityPort` em `src/domain/ports/provider-identity.port.ts`) e aplicada nos controllers de negócio via `ProviderAuthGuard` (`src/infrastructure/auth/auth.guard.ts`), mantendo `/health/live` e `/health/ready` abertos.

- **Modo padrão (`AUTH_MODE=noop`)**: Permite execução direta dos testes automatizados e chamadas locais sem exigir container extra de IdP.
- **Modo estrito neste repositório (`AUTH_MODE=strict`)**: exige header `Authorization: Bearer` e lê `sub`, `provider_id` e `scope` do payload do JWT. Não valida assinatura.
- **Desenho de produção (não implementado neste timebox)**: Keycloak ou Zitadel emitem o access token via `client_credentials`. O mesmo `ProviderIdentityPort` passaria a validar a assinatura no JWKS do IdP e a recusar a chamada quando `caller.providerId` divergir do `providerId` do corpo. Health checks continuam sem guarda.

---

## 8. Experimento de Teste de Carga (`bun run test:load`)

Executamos um benchmark reproduzível (`test/load/load-test.ts`) contra **3 instâncias simultâneas** da aplicação conectadas ao PostgreSQL 16 e LocalStack SQS reais em containers Docker:

- **Metodologia**:
  - **Fase 1 (Paralelismo entre Wallets)**: 200 transações (`BET`, `WIN`, `LOSS`) distribuídas entre 20 carteiras com concorrência 25.
  - **Fase 2 (Hot Wallet + Replay Storm)**: 100 requisições concorrentes sobre uma única carteira (40 envios paralelos da mesma aposta + 60 apostas distintas disputando o saldo).
  - **Fase 3 (Drenagem de Outbox + Reconciliação)**: Publicação de todos os eventos da outbox e verificação da invariante `wallet.balance == calculatedBalance` nas 20 carteiras.
- **Resultados Empíricos Obtidos**:
  - **Throughput**: `486.48 req/s`
  - **Latência**: `p50 = 39.27 ms`, `p95 = 127.18 ms`, `p99 = 134.84 ms`, `max = 149.92 ms`
  - **Taxa de Erro (HTTP 5xx)**: `0.00%` (0 falhas em 300 requisições concorrentes)
  - **Duplicatas Detectadas**: `39` replays idempotentes exatos na tempestade concorrente
  - **Consistência Final do Ledger**: `100%` (`allWalletsReconciledConsistent: true`)

---

## 9. Trade-offs e Limitações Conhecidas

1. **Pessimistic Locking (`SELECT ... FOR UPDATE`) vs. Optimistic Locking**:
   - *Trade-off*: Mantém a conexão do pool ocupada durante a transação daquela wallet (~2–5ms), mas elimina abortos em cascata em *hot wallets* e garante justiça na fila de execução.
2. **Polling de Outbox (`FOR UPDATE SKIP LOCKED`) vs. CDC (Debezium / Logical Replication)**:
   - *Trade-off*: Polling a cada 200ms adiciona um lag médio de ~100–250ms e realiza queries periódicas no PostgreSQL, mas é simples, autocontido e não exige infraestrutura de Kafka Connect.
3. **Tabela de Ledger Única vs. Particionamento**:
   - *Limitação*: Em produção com bilhões de lançamentos, `wallet_ledger_entries` e `wager_transactions` deveriam ser particionadas por `created_at` (mensal) ou hash de `wallet_id`, mantendo snapshots periódicos de reconciliação para evitar `SUM()` histórico completo.

