export interface AuthenticatedCaller {
  subject: string;
  providerId?: string;
  scopes: string[];
  authenticated: boolean;
}

export const PROVIDER_IDENTITY_PORT = Symbol("PROVIDER_IDENTITY_PORT");

export interface ProviderIdentityPort {
  /**
   * Verifies caller credentials (e.g. OIDC JWT issued by Keycloak/Zitadel)
   * and optionally enforces that the token's provider claim matches the payload providerId.
   */
  verifyCaller(headers: Record<string, string | string[] | undefined>): Promise<AuthenticatedCaller>;
}

