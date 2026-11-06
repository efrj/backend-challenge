export interface AuthenticatedCaller {
  subject: string;
  providerId?: string;
  scopes: string[];
  authenticated: boolean;
  issuer?: string;
  clientId?: string;
}

export const PROVIDER_IDENTITY_PORT = Symbol("PROVIDER_IDENTITY_PORT");

export interface ProviderIdentityPort {
  /**
   * Verifies caller credentials (OIDC/OAuth2 JWT issued by Casdoor and signed via JWKS RS256)
   * and extracts the authenticated subject, provider identity (`providerId`), and scopes.
   */
  verifyCaller(
    headers: Record<string, string | string[] | undefined>,
  ): Promise<AuthenticatedCaller>;
}

