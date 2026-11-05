import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from "@nestjs/common";
import {
  PROVIDER_IDENTITY_PORT,
  type AuthenticatedCaller,
  type ProviderIdentityPort,
} from "../../domain/ports/provider-identity.port";
import { getAppConfig } from "../config/app-config";

/**
 * Default adapter implementing ProviderIdentityPort (Section 2).
 * AUTH_MODE=noop allows the request and records an anonymous caller.
 * AUTH_MODE=strict requires a Bearer token and reads `sub`, `provider_id` and `scope`
 * from the JWT payload. Signature verification via the IdP JWKS is the extension
 * point of this port; it is not implemented in this timebox.
 */
@Injectable()
export class ConfigurableProviderIdentityAdapter implements ProviderIdentityPort {
  async verifyCaller(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthenticatedCaller> {
    const authMode = getAppConfig().authMode;
    const rawAuth = headers["authorization"];
    const authHeader = Array.isArray(rawAuth) ? rawAuth[0] : rawAuth;

    if (authMode === "noop" && !authHeader) {
      return {
        subject: "anonymous-trusted-caller",
        scopes: ["wagering:write", "wagering:read", "wallets:write", "wallets:read"],
        authenticated: false,
      };
    }

    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      if (authMode === "strict") {
        throw new UnauthorizedException("Missing or invalid Bearer token");
      }
      return {
        subject: "anonymous-trusted-caller",
        scopes: ["wagering:write", "wagering:read", "wallets:write", "wallets:read"],
        authenticated: false,
      };
    }

    const token = authHeader.slice("Bearer ".length).trim();
    const parts = token.split(".");
    if (parts.length === 3 && parts[1]) {
      try {
        const payload = JSON.parse(
          Buffer.from(parts[1], "base64url").toString("utf8"),
        ) as Record<string, unknown>;
        return {
          subject: String(payload.sub ?? "oidc-subject"),
          providerId:
            typeof payload.provider_id === "string"
              ? payload.provider_id
              : undefined,
          scopes:
            typeof payload.scope === "string" ? payload.scope.split(" ") : [],
          authenticated: true,
        };
      } catch {
        if (authMode === "strict") {
          throw new UnauthorizedException("Invalid JWT payload");
        }
      }
    }

    if (authMode === "strict") {
      throw new UnauthorizedException("Invalid Bearer token format");
    }

    return {
      subject: "bearer-caller",
      scopes: ["wagering:write", "wagering:read"],
      authenticated: true,
    };
  }
}

@Injectable()
export class ProviderAuthGuard implements CanActivate {
  constructor(
    @Inject(PROVIDER_IDENTITY_PORT)
    private readonly identityPort: ProviderIdentityPort,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<{
      headers: Record<string, string | string[] | undefined>;
      caller?: AuthenticatedCaller;
    }>();
    req.caller = await this.identityPort.verifyCaller(req.headers ?? {});
    return true;
  }
}
