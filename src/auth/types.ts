import type { IncomingMessage } from "node:http";

export interface AuthUser {
  id: string;
  email: string;
  displayName?: string;
  emailVerified: boolean;
  createdAt: string;
}

export interface AuthSignUpResult {
  user: AuthUser | null;
  sessionCreated: boolean;
  duplicatePossible: boolean;
}

/**
 * A PKCE exchange can report the flow type kept with its server-side verifier.
 * The optional marker also lets lightweight test gateways model older providers;
 * callers must fail closed when it is absent.
 */
export interface AuthCodeExchangeUser extends AuthUser {
  redirectType?: string | null;
}

export interface AuthGateway {
  getCurrentUser(): Promise<AuthUser | null>;
  signUp(input: { email: string; password: string; redirectTo: string }): Promise<AuthSignUpResult>;
  signIn(input: { email: string; password: string }): Promise<AuthUser>;
  resendVerification(input: { email: string; redirectTo: string }): Promise<void>;
  requestPasswordReset(input: { email: string; redirectTo: string }): Promise<void>;
  verifyToken(input: { tokenHash: string; type: string }): Promise<AuthUser>;
  exchangeCode(input: { code: string; flowId?: string }): Promise<AuthCodeExchangeUser>;
  updatePassword(password: string): Promise<AuthUser>;
  signOut(scope: "local" | "global"): Promise<void>;
}

export class AuthProviderError extends Error {
  readonly code: string;
  readonly status: number;

  constructor(code: string, message: string, status = 500) {
    super(message);
    this.name = "AuthProviderError";
    this.code = code;
    this.status = status;
  }
}

export interface AuthResponseState {
  cookies: string[];
  headers: Record<string, string>;
}

export interface AuthConfig {
  supabaseUrl: string;
  publishableKey: string;
  siteUrl: URL;
  secureCookies: boolean;
  trustProxy: boolean;
  trustedProxyHops?: number;
  trustedProxyAddresses?: string[];
  recoverySecret?: string;
}

export interface AuthRequestContext {
  request: IncomingMessage;
  config: AuthConfig;
  responseState: AuthResponseState;
  gateway: AuthGateway;
}

export type AuthGatewayFactory = (
  request: IncomingMessage,
  config: AuthConfig,
  responseState: AuthResponseState,
) => AuthGateway;
