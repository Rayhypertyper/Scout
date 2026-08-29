import { AuthHttpError } from "./http.js";
import { AuthProviderError } from "./types.js";

const ACCOUNT_STATE_CODES = new Set([
  "email_exists",
  "user_already_exists",
  "user_not_found",
  "email_not_confirmed",
  "email_address_not_authorized",
]);

const INVALID_LINK_CODES = new Set([
  "otp_expired",
  "bad_code_verifier",
  "flow_state_not_found",
  "flow_state_expired",
  "invite_not_found",
  "bad_oauth_state",
  "bad_oauth_callback",
]);

export function isNeutralAccountStateError(error: unknown): boolean {
  return error instanceof AuthProviderError && ACCOUNT_STATE_CODES.has(error.code);
}

export function providerErrorToHttp(error: unknown, operation: "login" | "signup" | "resend" | "forgot" | "callback" | "reset" | "logout" | "session"): AuthHttpError {
  if (error instanceof AuthHttpError) return error;
  if (!(error instanceof AuthProviderError)) {
    return new AuthHttpError(503, "AUTH_UNAVAILABLE", "Authentication is temporarily unavailable. Try again in a moment.");
  }

  if (error.code === "email_not_confirmed" && operation === "login") {
    return new AuthHttpError(403, "EMAIL_NOT_VERIFIED", "Verify your email before logging in. You can resend the message below.", { field: "email" });
  }
  if ((error.code === "invalid_credentials" || error.code === "user_not_found") && operation === "login") {
    return new AuthHttpError(401, "INVALID_CREDENTIALS", "The email or password is incorrect. Check both fields and try again.", { field: "email" });
  }
  if (error.code === "weak_password") {
    return new AuthHttpError(422, "WEAK_PASSWORD", "Choose a stronger password with at least 10 characters, including a letter and a number.", { field: "password" });
  }
  if (error.code === "same_password") {
    return new AuthHttpError(422, "SAME_PASSWORD", "Choose a password you have not used for this account.", { field: "password" });
  }
  if (error.code === "signup_disabled" || error.code === "email_provider_disabled" || error.code === "provider_disabled") {
    return new AuthHttpError(503, "AUTH_NOT_CONFIGURED", "Email authentication is not enabled yet. Contact the Scout administrator.");
  }
  if (error.code === "over_request_rate_limit" || error.code === "over_email_send_rate_limit" || error.status === 429) {
    return new AuthHttpError(429, "RATE_LIMITED", "Too many attempts. Wait a minute, then try again.", { retryAfter: 60 });
  }
  if (INVALID_LINK_CODES.has(error.code) || (operation === "callback" && error.status >= 400 && error.status < 500)) {
    return new AuthHttpError(400, "LINK_INVALID", "This link is invalid or has expired. Request a new email and try again.");
  }
  if (error.code === "session_expired" || error.code === "session_not_found" || error.code === "refresh_token_not_found") {
    return new AuthHttpError(401, "SESSION_EXPIRED", "Your session has expired. Log in again to continue.");
  }
  if (error.code === "request_timeout" || error.code === "hook_timeout" || error.code === "hook_timeout_after_retry" || error.status >= 500) {
    return new AuthHttpError(503, "AUTH_UNAVAILABLE", "Authentication is temporarily unavailable. Try again in a moment.");
  }
  if (operation === "logout") {
    return new AuthHttpError(503, "LOGOUT_FAILED", "Scout could not finish logging you out. Try again.");
  }
  if (operation === "reset") {
    return new AuthHttpError(400, "RESET_FAILED", "Scout could not update the password. Request a new reset link and try again.");
  }
  return new AuthHttpError(400, "AUTH_REQUEST_FAILED", "Scout could not complete that request. Check the form and try again.");
}
