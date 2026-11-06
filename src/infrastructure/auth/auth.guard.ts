import {
  CanActivate,
  ExecutionContext,
  ForbiddenException,
  Inject,
  Injectable,
  Optional,
  UnauthorizedException,
} from "@nestjs/common";
import {
  createRemoteJWKSet,
  jwtVerify,
  type JWTPayload,
  type JWTVerifyGetKey,
  type JWTVerifyOptions,
} from "jose";
import {
  PROVIDER_IDENTITY_PORT,
  type AuthenticatedCaller,
  type ProviderIdentityPort,
} from "../../domain/ports/provider-identity.port";
import { getAppConfig } from "../config/app-config";
import { MetricsService } from "../observability/metrics.service";
import { StructuredLoggerService } from "../observability/structured-logger.service";

export const CUSTOM_JWKS_RESOLVER = Symbol("CUSTOM_JWKS_RESOLVER");

const DEFAULT_SCOPES = [
  "wagering:write",
  "wagering:read",
  "wallets:write",
  "wallets:read",
];

/**
 * Adapter implementing ProviderIdentityPort (Section 2).
 *
 * - `AUTH_MODE=noop`: Allows requests without a token (recording an anonymous
 *   trusted caller for local development and automated test suites). If a Bearer
 *   JWT is sent, its claims (`sub`, `provider_id`/`tag`/`name`, `scope`) are
 *   decoded and attached to `req.caller`.
 * - `AUTH_MODE=casdoor` (or `strict`): Enforces full OAuth2/OIDC JWT authentication
 *   against Casdoor's JWKS endpoint (`/.well-known/jwks`), verifying RS256/ES256
 *   cryptographic signatures, `exp`/`nbf` timestamps, and optional `iss`/`aud`
 *   claims. Also enforces provider isolation (`403 Forbidden`) when a provider-scoped
 *   token attempts to act on behalf of another `providerId`.
 */
@Injectable()
export class ConfigurableProviderIdentityAdapter implements ProviderIdentityPort {
  private readonly jwksCache = new Map<string, JWTVerifyGetKey>();

  constructor(
    @Optional()
    @Inject(CUSTOM_JWKS_RESOLVER)
    private readonly customJwks?: JWTVerifyGetKey,
    @Optional()
    @Inject(MetricsService)
    private readonly metrics?: MetricsService,
    @Optional()
    @Inject(StructuredLoggerService)
    private readonly logger?: StructuredLoggerService,
  ) {}

  async verifyCaller(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthenticatedCaller> {
    const config = getAppConfig();
    const authMode = config.authMode;
    const rawAuth = headers["authorization"] ?? headers["Authorization"];
    const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;

    if (authMode === "noop" && !authHeader) {
      this.metrics?.recordAuthAttempt("anonymous");
      return {
        subject: "anonymous-trusted-caller",
        scopes: DEFAULT_SCOPES,
        authenticated: false,
      };
    }

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (authMode === "casdoor" || authMode === "strict") {
        this.metrics?.recordAuthAttempt("unauthorized");
        this.logger?.warn("Authentication rejected: Missing or invalid Bearer token", {
          authMode,
        });
        throw new UnauthorizedException("Missing or invalid Bearer token");
      }
      this.metrics?.recordAuthAttempt("anonymous");
      return {
        subject: "anonymous-trusted-caller",
        scopes: DEFAULT_SCOPES,
        authenticated: false,
      };
    }

    const token = authHeader.slice("Bearer ".length).trim();
    if (!token) {
      if (authMode === "casdoor" || authMode === "strict") {
        this.metrics?.recordAuthAttempt("unauthorized");
        this.logger?.warn("Authentication rejected: Empty Bearer token", {
          authMode,
        });
        throw new UnauthorizedException("Empty Bearer token");
      }
      this.metrics?.recordAuthAttempt("anonymous");
      return {
        subject: "anonymous-trusted-caller",
        scopes: DEFAULT_SCOPES,
        authenticated: false,
      };
    }

    if (authMode === "casdoor" || authMode === "strict") {
      try {
        const caller = await this.verifyWithCasdoorJwks(token, config.casdoor);
        this.metrics?.recordAuthAttempt("authenticated");
        return caller;
      } catch (err) {
        this.metrics?.recordAuthAttempt("unauthorized");
        this.logger?.warn("Authentication rejected: Casdoor JWT verification failed", {
          authMode,
          error: err instanceof Error ? err.message : String(err),
        });
        throw err;
      }
    }

    const caller = this.decodeUnverifiedTokenForNoop(token);
    this.metrics?.recordAuthAttempt("authenticated");
    return caller;
  }

  private async verifyWithCasdoorJwks(
    token: string,
    casdoorConfig: {
      endpoint: string;
      jwksUrl: string;
      issuer?: string;
      audience?: string;
    },
  ): Promise<AuthenticatedCaller> {
    const jwks = this.getJwksResolver(casdoorConfig.jwksUrl);
    const verifyOptions: JWTVerifyOptions = {
      algorithms: ["RS256", "RS384", "RS512", "ES256"],
    };

    if (casdoorConfig.issuer) {
      verifyOptions.issuer = casdoorConfig.issuer;
    }
    if (casdoorConfig.audience) {
      verifyOptions.audience = casdoorConfig.audience;
    }

    let payload: JWTPayload;
    try {
      const verified = await jwtVerify(token, jwks, verifyOptions);
      payload = verified.payload;
    } catch (error) {
      throw new UnauthorizedException(
        `Casdoor JWT verification failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    return this.mapPayloadToCaller(payload);
  }

  private getJwksResolver(jwksUrl: string): JWTVerifyGetKey {
    if (this.customJwks) {
      return this.customJwks;
    }

    let resolver = this.jwksCache.get(jwksUrl);
    if (!resolver) {
      resolver = createRemoteJWKSet(new URL(jwksUrl), {
        cooldownDuration: 30_000,
        cacheMaxAge: 600_000,
      });
      this.jwksCache.set(jwksUrl, resolver);
    }
    return resolver;
  }

  private decodeUnverifiedTokenForNoop(token: string): AuthenticatedCaller {
    const parts = token.split(".");
    if (parts.length === 3 && parts[1]) {
      try {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64url").toString("utf8"),
        ) as JWTPayload;
        return this.mapPayloadToCaller(payload);
      } catch {
        // Fall through to generic bearer caller in noop mode
      }
    }

    return {
      subject: "bearer-caller",
      scopes: DEFAULT_SCOPES,
      authenticated: true,
    };
  }

  private mapPayloadToCaller(payload: JWTPayload): AuthenticatedCaller {
    const record = payload as Record<string, unknown>;
    const subject = String(
      record.sub ?? record.id ?? record.name ?? "oidc-subject",
    );
    const providerId = extractProviderId(record);
    const scopes = extractScopes(record.scope);
    const issuer =
      typeof record.iss === "string" ? record.iss : undefined;
    const clientId =
      typeof record.azp === "string"
        ? record.azp
        : typeof record.client_id === "string"
          ? record.client_id
          : undefined;

    return {
      subject,
      providerId,
      scopes,
      authenticated: true,
      issuer,
      clientId,
    };
  }
}

/**
 * Extracts the game provider identifier (`providerId`) from a Casdoor or generic OIDC JWT.
 *
 * Resolution order:
 * 1. Explicit `provider_id` claim (`payload.provider_id`)
 * 2. Casdoor user `tag` field (`payload.tag`)
 * 3. Casdoor application/user `name` (`payload.name`), unless the caller is the
 *    global `admin` or belongs to the `built-in` organization (which acts as an
 *    unrestricted platform operator).
 */
function extractProviderId(
  payload: Record<string, unknown>,
): string | undefined {
  if (
    typeof payload.provider_id === "string" &&
    payload.provider_id.trim() !== ""
  ) {
    return payload.provider_id.trim();
  }

  if (typeof payload.tag === "string" && payload.tag.trim() !== "") {
    return payload.tag.trim();
  }

  if (typeof payload.name === "string" && payload.name.trim() !== "") {
    const name = payload.name.trim();
    const owner =
      typeof payload.owner === "string" ? payload.owner.trim() : "";
    if (name === "admin" || owner === "built-in") {
      return undefined;
    }
    return name;
  }

  return undefined;
}

function extractScopes(rawScope: unknown): string[] {
  if (typeof rawScope === "string" && rawScope.trim() !== "") {
    return rawScope
      .trim()
      .split(/\s+/)
      .filter((s) => s.length > 0);
  }
  if (Array.isArray(rawScope)) {
    return rawScope.filter((s): s is string => typeof s === "string");
  }
  return DEFAULT_SCOPES;
}

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY_PORT)
    private readonly identityPort: ProviderIdentityPort,
    @Optional()
    @Inject(MetricsService)
    private readonly metrics?: MetricsService,
    @Optional()
    @Inject(StructuredLoggerService)
    private readonly logger?: StructuredLoggerService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      body?: Record<string, unknown>;
      params?: Record<string, unknown>;
      caller?: AuthenticatedCaller;
    }>();

    const caller = await this.identityPort.verifyCaller(req.headers ?? {});
    req.caller = caller;

    // Enforce tenant/provider isolation when caller is bound to a specific providerId
    if (caller.authenticated && caller.providerId) {
      const bodyProviderId =
        typeof req.body?.providerId === "string" &&
        req.body.providerId.trim() !== ""
          ? req.body.providerId.trim()
          : undefined;

      if (bodyProviderId && bodyProviderId !== caller.providerId) {
        this.metrics?.recordAuthForbidden(caller.providerId, bodyProviderId);
        this.logger?.warn("Cross-provider access denied (body mismatch)", {
          callerProviderId: caller.providerId,
          targetProviderId: bodyProviderId,
          subject: caller.subject,
        });
        throw new ForbiddenException(
          `Authenticated provider '${caller.providerId}' is not authorized to submit transactions for provider '${bodyProviderId}'`,
        );
      }

      const paramProviderId =
        typeof req.params?.providerId === "string" &&
        req.params.providerId.trim() !== ""
          ? req.params.providerId.trim()
          : undefined;

      if (paramProviderId && paramProviderId !== caller.providerId) {
        this.metrics?.recordAuthForbidden(caller.providerId, paramProviderId);
        this.logger?.warn("Cross-provider access denied (param mismatch)", {
          callerProviderId: caller.providerId,
          targetProviderId: paramProviderId,
          subject: caller.subject,
        });
        throw new ForbiddenException(
          `Authenticated provider '${caller.providerId}' is not authorized to access resources of provider '${paramProviderId}'`,
        );
      }
    }

    return true;
  }
}
