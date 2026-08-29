/* global CustomEvent, HTMLButtonElement, fetch, window */

export class AuthClientError extends Error {
  constructor(message, options = {}) {
    super(message);
    this.name = "AuthClientError";
    this.code = options.code ?? "AUTH_REQUEST_FAILED";
    this.field = options.field ?? null;
    this.retryAfter = options.retryAfter ?? null;
  }
}

class RoleRadarAuthClient {
  #state = {
    status: "loading",
    configured: true,
    user: null,
    recoveryReady: false,
    error: null,
  };

  #csrfToken = null;
  #listeners = new Set();
  #bootstrapPromise = null;

  getState() {
    return { ...this.#state };
  }

  subscribe(listener) {
    this.#listeners.add(listener);
    listener(this.getState());
    return () => this.#listeners.delete(listener);
  }

  async bootstrap(options = {}) {
    if (this.#bootstrapPromise && !options.force) return this.#bootstrapPromise;
    this.#bootstrapPromise = this.#loadSession();
    try {
      return await this.#bootstrapPromise;
    } finally {
      this.#bootstrapPromise = null;
    }
  }

  async #loadSession() {
    try {
      const response = await fetch("/api/auth/session", {
        method: "GET",
        headers: { Accept: "application/json" },
        credentials: "same-origin",
        cache: "no-store",
      });
      const payload = await response.json();
      this.#csrfToken = typeof payload.csrfToken === "string" ? payload.csrfToken : null;
      if (!response.ok) throw this.#errorFromResponse(response, payload);
      this.#setState({
        status: payload.authenticated ? "authenticated" : "anonymous",
        configured: payload.configured !== false,
        user: payload.user ?? null,
        recoveryReady: payload.recoveryReady === true,
        error: null,
      });
      return this.getState();
    } catch (error) {
      const authError = error instanceof AuthClientError
        ? error
        : new AuthClientError("Scout could not check your session. Check your connection and try again.", { code: "NETWORK_ERROR" });
      this.#setState({
        status: "unavailable",
        configured: true,
        user: null,
        recoveryReady: false,
        error: authError,
      });
      throw authError;
    }
  }

  async signUp(input) {
    return this.#mutation("/api/auth/signup", input);
  }

  async signIn(input) {
    const payload = await this.#mutation("/api/auth/login", input);
    this.#setState({ status: "authenticated", configured: true, user: payload.user, recoveryReady: false, error: null });
    return payload;
  }

  async resendVerification(email) {
    return this.#mutation("/api/auth/resend-verification", { email });
  }

  async requestPasswordReset(email) {
    return this.#mutation("/api/auth/forgot-password", { email });
  }

  async updatePassword(input) {
    const payload = await this.#mutation("/api/auth/reset-password", input);
    this.#setState({ status: "anonymous", configured: true, user: null, recoveryReady: false, error: null });
    return payload;
  }

  async signOut() {
    const payload = await this.#mutation("/api/auth/logout", {});
    this.#setState({ status: "anonymous", configured: true, user: null, recoveryReady: false, error: null });
    return payload;
  }

  async #mutation(path, input) {
    if (!this.#csrfToken) await this.bootstrap();
    if (!this.#csrfToken) throw new AuthClientError("Your form session expired. Reload the page and try again.", { code: "CSRF_INVALID" });
    let response;
    try {
      response = await fetch(path, {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
          "X-CSRF-Token": this.#csrfToken,
        },
        credentials: "same-origin",
        cache: "no-store",
        body: JSON.stringify(input),
      });
    } catch {
      throw new AuthClientError("Scout could not reach the authentication service. Check your connection and try again.", { code: "NETWORK_ERROR" });
    }
    let payload;
    try {
      payload = await response.json();
    } catch {
      throw new AuthClientError("Scout received an invalid authentication response. Try again.", { code: "INVALID_RESPONSE" });
    }
    if (!response.ok) throw this.#errorFromResponse(response, payload);
    return payload;
  }

  #errorFromResponse(response, payload) {
    const error = payload?.error ?? {};
    const retryAfterHeader = Number.parseInt(response.headers.get("Retry-After") ?? "", 10);
    return new AuthClientError(error.message ?? "Scout could not complete that request. Try again.", {
      code: error.code,
      field: error.field,
      retryAfter: Number.isFinite(retryAfterHeader) ? retryAfterHeader : null,
    });
  }

  #setState(next) {
    this.#state = { ...next };
    for (const listener of this.#listeners) listener(this.getState());
    window.dispatchEvent(new CustomEvent("roleradar:authchange", { detail: this.getState() }));
  }
}

export const authClient = new RoleRadarAuthClient();

const wiredLogoutButtons = new WeakSet();

export function wireLogoutButton(button, options = {}) {
  if (!(button instanceof HTMLButtonElement) || wiredLogoutButtons.has(button)) return () => {};
  wiredLogoutButtons.add(button);
  const label = button.querySelector(".button-label");
  const restingLabel = label?.textContent ?? button.textContent ?? "Log Out";
  const listener = async () => {
    button.disabled = true;
    button.setAttribute("aria-busy", "true");
    if (label) label.textContent = "Logging Out…";
    try {
      const result = await authClient.signOut();
      window.location.assign(options.redirectTo ?? result.redirect ?? "/");
    } catch (error) {
      button.disabled = false;
      button.removeAttribute("aria-busy");
      if (label) label.textContent = restingLabel;
      button.dispatchEvent(new CustomEvent("roleradar:autherror", { detail: error, bubbles: true }));
    }
  };
  button.addEventListener("click", listener);
  return () => {
    button.removeEventListener("click", listener);
    wiredLogoutButtons.delete(button);
  };
}

export function protectClientRoute(options = {}) {
  return authClient.bootstrap().then((state) => {
    if (state.status !== "authenticated") {
      const next = `${window.location.pathname}${window.location.search}${window.location.hash}`;
      window.location.replace(`${options.loginPath ?? "/login"}?next=${encodeURIComponent(next)}`);
      return null;
    }
    return state.user;
  });
}
