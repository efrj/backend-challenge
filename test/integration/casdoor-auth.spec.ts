import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { randomUUID } from "crypto";
import { getAppConfig } from "../../src/infrastructure/config/app-config";
import {
  assertAllWalletsConsistent,
  createTestAppInstance,
  TestAppInstance,
} from "../helpers/test-app";

interface CasdoorTokenResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
  scope?: string;
}

async function requestCasdoorToken(params: Record<string, string>): Promise<string> {
  const { casdoor } = getAppConfig();
  const body = new URLSearchParams(params);
  const res = await fetch(`${casdoor.endpoint}/api/login/oauth/access_token`, {
    method: "POST",
    headers: {
      "content-type": "application/x-www-form-urlencoded",
      accept: "application/json",
    },
    body: body.toString(),
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Casdoor token endpoint failed (${res.status}): ${text}`);
  }

  const data = (await res.json()) as CasdoorTokenResponse & { error?: string; error_description?: string };
  if (!data.access_token) {
    throw new Error(
      `Casdoor did not return an access_token: ${JSON.stringify(data)}`,
    );
  }
  return data.access_token;
}

describe("Integration — Casdoor OIDC/OAuth2 Authentication & Provider Isolation", () => {
  let instance: TestAppInstance;
  const createdWalletIds: string[] = [];
  const originalAuthMode = process.env.AUTH_MODE;

  beforeAll(async () => {
    instance = await createTestAppInstance({ workersEnabled: false });
    process.env.AUTH_MODE = "casdoor";
  });

  afterAll(async () => {
    process.env.AUTH_MODE = originalAuthMode ?? "noop";
    await assertAllWalletsConsistent(instance, createdWalletIds);
    await instance.close();
  });

  it("rejects unauthenticated requests with 401 when AUTH_MODE=casdoor while keeping /health/* and /metrics open", async () => {
    const liveRes = await fetch(`${instance.baseUrl}/health/live`);
    expect(liveRes.status).toBe(200);

    const readyRes = await fetch(`${instance.baseUrl}/health/ready`);
    expect(readyRes.status).toBe(200);

    const metricsRes = await fetch(`${instance.baseUrl}/metrics`);
    expect(metricsRes.status).toBe(200);

    const unauthWalletRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        playerId: randomUUID(),
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    expect(unauthWalletRes.status).toBe(401);

    const invalidTokenRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.e30.invalid",
      },
      body: JSON.stringify({
        playerId: randomUUID(),
        initialBalance: { amount: "100.00", currency: "BRL" },
      }),
    });
    expect(invalidTokenRes.status).toBe(401);
  });

  it("authenticates real Casdoor OAuth2 tokens (client_credentials & password grants), processes wagers, and blocks cross-provider spoofing with 403", async () => {
    // 1. Obtain real RS256 JWT for provider-a via client_credentials grant
    const providerAToken = await requestCasdoorToken({
      grant_type: "client_credentials",
      client_id: "provider-a-client-id",
      client_secret: "provider-a-client-secret",
      scope: "openid profile wagering:write wagering:read",
    });

    // 2. Obtain real RS256 JWT for provider-b via password grant
    const providerBToken = await requestCasdoorToken({
      grant_type: "password",
      client_id: "provider-b-client-id",
      client_secret: "provider-b-client-secret",
      username: "provider-b",
      password: "provider-b-secret",
      scope: "openid profile wagering:write wagering:read",
    });

    // 3. Create a wallet using provider-a token
    const playerId = randomUUID();
    const createWalletRes = await fetch(`${instance.baseUrl}/wallets`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: `Bearer ${providerAToken}`,
      },
      body: JSON.stringify({
        playerId,
        initialBalance: { amount: "500.00", currency: "BRL" },
      }),
    });
    expect(createWalletRes.status).toBe(201);
    const wallet = (await createWalletRes.json()) as { id: string };
    createdWalletIds.push(wallet.id);

    // 4. Submit a BET transaction as provider-a -> 200 OK
    const extBetId = `casdoor-bet-${randomUUID()}`;
    const betRes = await fetch(`${instance.baseUrl}/wagering/transactions`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "idempotency-key": randomUUID(),
        authorization: `Bearer ${providerAToken}`,
      },
      body: JSON.stringify({
        providerId: "provider-a",
        externalTransactionId: extBetId,
        playerId,
        walletId: wallet.id,
        roundId: "round-casdoor-1",
        gameId: "slots-jungle",
        kind: "BET",
        money: { amount: "50.00", currency: "BRL" },
      }),
    });
    expect(betRes.status).toBe(200);
    const betBody = (await betRes.json()) as {
      status: string;
      balance: { amount: string; currency: string };
    };
    expect(betBody.status).toBe("PROCESSED");
    expect(betBody.balance).toEqual({ amount: "450.00", currency: "BRL" });

    // 5. Provider-A token attempting to submit a transaction for provider-b -> 403 Forbidden
    const spoofBetRes = await fetch(
      `${instance.baseUrl}/wagering/transactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          authorization: `Bearer ${providerAToken}`,
        },
        body: JSON.stringify({
          providerId: "provider-b",
          externalTransactionId: `spoof-${randomUUID()}`,
          playerId,
          walletId: wallet.id,
          roundId: "round-casdoor-1",
          gameId: "slots-jungle",
          kind: "BET",
          money: { amount: "10.00", currency: "BRL" },
        }),
      },
    );
    expect(spoofBetRes.status).toBe(403);

    // 6. Provider-B token attempting to query provider-a's transaction -> 403 Forbidden
    const crossReadRes = await fetch(
      `${instance.baseUrl}/providers/provider-a/wagering/transactions/${extBetId}`,
      {
        headers: {
          authorization: `Bearer ${providerBToken}`,
        },
      },
    );
    expect(crossReadRes.status).toBe(403);

    // 7. Provider-B token submitting its own WIN transaction for provider-b -> 200 OK
    const providerBBetId = `casdoor-b-bet-${randomUUID()}`;
    const providerBBetRes = await fetch(
      `${instance.baseUrl}/wagering/transactions`,
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "idempotency-key": randomUUID(),
          authorization: `Bearer ${providerBToken}`,
        },
        body: JSON.stringify({
          providerId: "provider-b",
          externalTransactionId: providerBBetId,
          playerId,
          walletId: wallet.id,
          roundId: "round-casdoor-2",
          gameId: "roulette-jungle",
          kind: "BET",
          money: { amount: "25.00", currency: "BRL" },
        }),
      },
    );
    expect(providerBBetRes.status).toBe(200);
  });
});

