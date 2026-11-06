import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import type { ExecutionContext } from "@nestjs/common";
import { ForbiddenException, UnauthorizedException } from "@nestjs/common";
import {
  createLocalJWKSet,
  exportJWK,
  generateKeyPair,
  SignJWT,
  type CryptoKey,
  type JWTVerifyGetKey,
} from "jose";
import {
  ConfigurableProviderIdentityAdapter,
  ProviderAuthGuard,
} from "../../src/infrastructure/auth/auth.guard";

describe("Casdoor OIDC / JWKS Authentication & Provider Isolation (Unit)", () => {
  const originalAuthMode = process.env.AUTH_MODE;
  const originalCasdoorIssuer = process.env.CASDOOR_ISSUER;
  const originalCasdoorAudience = process.env.CASDOOR_AUDIENCE;

  let privateKey: CryptoKey;
  let wrongPrivateKey: CryptoKey;
  let localJwks: JWTVerifyGetKey;

  beforeAll(async () => {
    const kp = await generateKeyPair("RS256");
    privateKey = kp.privateKey;
    const publicJwk = await exportJWK(kp.publicKey);
    publicJwk.kid = "cert-built-in";
    publicJwk.alg = "RS256";
    publicJwk.use = "sig";

    localJwks = createLocalJWKSet({ keys: [publicJwk] });

    const wrongKp = await generateKeyPair("RS256");
    wrongPrivateKey = wrongKp.privateKey;
  });

  afterEach(() => {
    process.env.AUTH_MODE = originalAuthMode ?? "noop";
    if (originalCasdoorIssuer === undefined) {
      delete process.env.CASDOOR_ISSUER;
    } else {
      process.env.CASDOOR_ISSUER = originalCasdoorIssuer;
    }
    if (originalCasdoorAudience === undefined) {
      delete process.env.CASDOOR_AUDIENCE;
    } else {
      process.env.CASDOOR_AUDIENCE = originalCasdoorAudience;
    }
  });

  it("allows unauthenticated requests in AUTH_MODE=noop and marks caller as anonymous", async () => {
    process.env.AUTH_MODE = "noop";
    const adapter = new ConfigurableProviderIdentityAdapter(localJwks);
    const caller = await adapter.verifyCaller({});

    expect(caller.authenticated).toBe(false);
    expect(caller.subject).toBe("anonymous-trusted-caller");
    expect(caller.providerId).toBeUndefined();
  });

  it("rejects missing or malformed Authorization header in AUTH_MODE=casdoor with 401", async () => {
    process.env.AUTH_MODE = "casdoor";
    const adapter = new ConfigurableProviderIdentityAdapter(localJwks);

    await expect(adapter.verifyCaller({})).rejects.toBeInstanceOf(
      UnauthorizedException,
    );
    await expect(
      adapter.verifyCaller({ authorization: "Basic dXNlcjpwYXNz" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("verifies RS256 Casdoor JWT signature via JWKS and extracts providerId from client_credentials / password claims", async () => {
    process.env.AUTH_MODE = "casdoor";
    const adapter = new ConfigurableProviderIdentityAdapter(localJwks);

    const token = await new SignJWT({
      owner: "jungle",
      name: "provider-a",
      id: "jungle/provider-a",
      tag: "provider-a",
      scope: "openid profile wagering:write wagering:read",
      azp: "provider-a-client-id",
    })
      .setProtectedHeader({ alg: "RS256", kid: "cert-built-in" })
      .setSubject("10000000-0000-4000-8000-000000000001")
      .setIssuer("http://localhost:8000")
      .setAudience("provider-a-client-id")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    const caller = await adapter.verifyCaller({
      authorization: `Bearer ${token}`,
    });

    expect(caller.authenticated).toBe(true);
    expect(caller.subject).toBe("10000000-0000-4000-8000-000000000001");
    expect(caller.providerId).toBe("provider-a");
    expect(caller.clientId).toBe("provider-a-client-id");
    expect(caller.scopes).toContain("wagering:write");
  });

  it("rejects JWT signed with an unknown private key or expired JWT with 401 Unauthorized", async () => {
    process.env.AUTH_MODE = "casdoor";
    const adapter = new ConfigurableProviderIdentityAdapter(localJwks);

    const forgedToken = await new SignJWT({
      owner: "jungle",
      name: "provider-a",
    })
      .setProtectedHeader({ alg: "RS256", kid: "cert-built-in" })
      .setSubject("forged-sub")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(wrongPrivateKey);

    await expect(
      adapter.verifyCaller({ authorization: `Bearer ${forgedToken}` }),
    ).rejects.toBeInstanceOf(UnauthorizedException);

    const expiredToken = await new SignJWT({
      owner: "jungle",
      name: "provider-a",
    })
      .setProtectedHeader({ alg: "RS256", kid: "cert-built-in" })
      .setSubject("expired-sub")
      .setIssuedAt(Math.floor(Date.now() / 1000) - 7200)
      .setExpirationTime(Math.floor(Date.now() / 1000) - 3600)
      .sign(privateKey);

    await expect(
      adapter.verifyCaller({ authorization: `Bearer ${expiredToken}` }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it("enforces provider isolation in ProviderAuthGuard (403 Forbidden when provider-a attempts to act as provider-b)", async () => {
    process.env.AUTH_MODE = "casdoor";
    const adapter = new ConfigurableProviderIdentityAdapter(localJwks);
    const guard = new ProviderAuthGuard(adapter);

    const providerAToken = await new SignJWT({
      owner: "admin",
      name: "provider-a",
      azp: "provider-a-client-id",
    })
      .setProtectedHeader({ alg: "RS256", kid: "cert-built-in" })
      .setSubject("admin/provider-a")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    const makeContext = (
      body?: Record<string, unknown>,
      params?: Record<string, unknown>,
    ): ExecutionContext =>
      ({
        switchToHttp: () => ({
          getRequest: () => ({
            headers: { authorization: `Bearer ${providerAToken}` },
            body,
            params,
          }),
        }),
      }) as unknown as ExecutionContext;

    // Matching providerId succeeds
    await expect(
      guard.canActivate(makeContext({ providerId: "provider-a" })),
    ).resolves.toBe(true);

    // Mismatched body.providerId throws 403 Forbidden
    await expect(
      guard.canActivate(makeContext({ providerId: "provider-b" })),
    ).rejects.toBeInstanceOf(ForbiddenException);

    // Mismatched params.providerId throws 403 Forbidden
    await expect(
      guard.canActivate(makeContext(undefined, { providerId: "provider-b" })),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it("allows global Casdoor admin token (owner='built-in', name='admin') to access any provider without restriction", async () => {
    process.env.AUTH_MODE = "casdoor";
    const adapter = new ConfigurableProviderIdentityAdapter(localJwks);
    const guard = new ProviderAuthGuard(adapter);

    const adminToken = await new SignJWT({
      owner: "built-in",
      name: "admin",
      azp: "provider-a-client-id",
    })
      .setProtectedHeader({ alg: "RS256", kid: "cert-built-in" })
      .setSubject("built-in/admin")
      .setIssuedAt()
      .setExpirationTime("1h")
      .sign(privateKey);

    const ctx = {
      switchToHttp: () => ({
        getRequest: () => ({
          headers: { authorization: `Bearer ${adminToken}` },
          body: { providerId: "provider-b" },
        }),
      }),
    } as unknown as ExecutionContext;

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
  });
});
