/* global FormData, HTMLInputElement, URLSearchParams, clearInterval, document, history, location, navigator, sessionStorage, setInterval, window */

import { AuthClientError, authClient, wireLogoutButton } from "/auth/auth-client.js";

const route = document.body.dataset.authRoute ?? "/login";
const numberFormatter = new Intl.NumberFormat(navigator.languages);
let resendTimer = null;

function element(selector, root = document) {
  return root.querySelector(selector);
}

function inputNamed(form, name) {
  const input = form.elements.namedItem(name);
  return input instanceof HTMLInputElement ? input : null;
}

function safeSessionGet(key) {
  try {
    return sessionStorage.getItem(key);
  } catch {
    return null;
  }
}

function safeSessionSet(key, value) {
  try {
    sessionStorage.setItem(key, value);
  } catch {
    // The flow still works when browser storage is unavailable.
  }
}

function safeSessionRemove(key) {
  try {
    sessionStorage.removeItem(key);
  } catch {
    // Nothing to remove when browser storage is unavailable.
  }
}

function setFieldError(form, fieldName, message) {
  const field = inputNamed(form, fieldName);
  const error = element(`[data-error-for="${fieldName}"]`, form);
  if (field) field.setAttribute("aria-invalid", message ? "true" : "false");
  if (error) error.textContent = message;
}

function clearFormErrors(form) {
  for (const field of form.querySelectorAll("input[aria-invalid]")) field.removeAttribute("aria-invalid");
  for (const error of form.querySelectorAll("[data-error-for]")) error.textContent = "";
  const message = element("[data-form-message]", form);
  if (message) {
    message.hidden = true;
    message.classList.remove("system-message-success");
    const text = element("[data-form-message-text]", message);
    if (text) text.textContent = "";
    const action = element("[data-unverified-action]", message);
    if (action) action.hidden = true;
  }
}

function showFormError(form, error) {
  const authError = error instanceof AuthClientError
    ? error
    : new AuthClientError("Scout could not complete that request. Try again.");
  if (authError.field && inputNamed(form, authError.field)) {
    setFieldError(form, authError.field, authError.message);
    inputNamed(form, authError.field)?.focus();
  } else {
    const message = element("[data-form-message]", form);
    const text = message ? element("[data-form-message-text]", message) : null;
    if (message && text) {
      text.textContent = authError.message;
      message.hidden = false;
      message.focus();
    }
  }
  if (authError.code === "EMAIL_NOT_VERIFIED") {
    const message = element("[data-form-message]", form);
    const text = message ? element("[data-form-message-text]", message) : null;
    const action = message ? element("[data-unverified-action]", message) : null;
    if (message && text) {
      text.textContent = authError.message;
      message.hidden = false;
      if (action) action.hidden = false;
      message.focus();
    }
  }
}

function setButtonPending(button, pending, pendingLabel) {
  if (!button) return;
  const label = element(".button-label", button);
  button.disabled = pending;
  if (pending) {
    button.setAttribute("aria-busy", "true");
    if (label) label.textContent = pendingLabel;
  } else {
    button.removeAttribute("aria-busy");
    if (label) label.textContent = button.dataset.readyLabel ?? "Submit";
  }
}

function validEmail(value) {
  return value.length <= 254 && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value);
}

function passwordRules(value) {
  return {
    length: value.length >= 10 && value.length <= 128,
    letter: /\p{L}/u.test(value),
    number: /\p{N}/u.test(value),
  };
}

function validateEmailField(form, options = {}) {
  const email = inputNamed(form, "email");
  if (!email || !validEmail(email.value.trim())) {
    setFieldError(form, "email", "Enter a valid email address.");
    if (options.focus) focusFirstInvalid(form);
    return false;
  }
  setFieldError(form, "email", "");
  return true;
}

function focusFirstInvalid(form) {
  form.querySelector('[aria-invalid="true"]')?.focus();
}

function validateLoginForm(form, options = {}) {
  const emailValid = validateEmailField(form);
  const password = inputNamed(form, "password");
  const passwordValid = Boolean(password?.value);
  setFieldError(form, "password", passwordValid ? "" : "Enter your password.");
  if (options.focus) focusFirstInvalid(form);
  return emailValid && passwordValid;
}

function validateStrongPasswordForm(form, options = {}) {
  const password = inputNamed(form, "password");
  const confirmation = inputNamed(form, "confirmPassword");
  const rules = passwordRules(password?.value ?? "");
  const passwordValid = Object.values(rules).every(Boolean);
  setFieldError(form, "password", passwordValid ? "" : "Use at least 10 characters, including a letter and a number.");
  const confirmationValid = Boolean(confirmation?.value) && password?.value === confirmation?.value;
  setFieldError(form, "confirmPassword", confirmationValid ? "" : "The passwords do not match yet.");
  if (options.focus) focusFirstInvalid(form);
  return passwordValid && confirmationValid;
}

function updatePasswordRequirements(input) {
  const form = input.form;
  if (!form) return;
  const rules = passwordRules(input.value);
  const signature = Object.entries(rules).map(([rule, passed]) => `${rule}:${passed ? "pass" : "pending"}`).join("|");
  for (const [rule, passed] of Object.entries(rules)) {
    const item = element(`[data-password-rule="${rule}"]`, form);
    if (item) item.dataset.state = passed ? "pass" : "pending";
  }
  const status = element("[data-password-status]", form);
  if (status && input.dataset.requirementsSignature !== undefined && input.dataset.requirementsSignature !== signature) {
    const remaining = Object.values(rules).filter((passed) => !passed).length;
    status.textContent = remaining > 0
      ? `${numberFormatter.format(remaining)} password requirement${remaining === 1 ? "" : "s"} remaining.`
      : "Password requirements met.";
  }
  input.dataset.requirementsSignature = signature;
}

function wirePasswordControls() {
  for (const button of document.querySelectorAll("[data-password-toggle]")) {
    button.addEventListener("click", () => {
      const input = document.getElementById(button.dataset.passwordToggle ?? "");
      if (!(input instanceof HTMLInputElement)) return;
      const show = input.type === "password";
      input.type = show ? "text" : "password";
      button.setAttribute("aria-pressed", show ? "true" : "false");
      button.setAttribute("aria-label", show ? "Hide Password" : "Show Password");
      input.focus({ preventScroll: true });
    });
  }
  for (const input of document.querySelectorAll('input[name="password"][autocomplete="new-password"]')) {
    input.addEventListener("input", () => updatePasswordRequirements(input));
    updatePasswordRequirements(input);
  }
}

function formPayload(form) {
  const payload = {};
  for (const [name, value] of new FormData(form).entries()) {
    if (typeof value === "string") payload[name] = value;
  }
  return payload;
}

function wireFieldRecovery(form, validator) {
  for (const input of form.querySelectorAll("input")) {
    input.addEventListener("input", () => {
      if (input.getAttribute("aria-invalid") === "true") validator(form);
    });
  }
}

function nextPath() {
  const next = new URLSearchParams(location.search).get("next");
  return next?.startsWith("/") && !next.startsWith("//") ? next : "/post-login";
}

function wireLogin() {
  const form = element("#login-form");
  if (!form) return;
  wireFieldRecovery(form, validateLoginForm);
  const unverifiedAction = element("[data-unverified-action]", form);
  unverifiedAction?.addEventListener("click", () => {
    const email = inputNamed(form, "email")?.value.trim() ?? "";
    if (email) safeSessionSet("roleradar.verificationEmail", email);
    window.location.assign("/verify-email");
  });
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    if (!validateLoginForm(form, { focus: true })) return;
    const button = element('button[type="submit"]', form);
    setButtonPending(button, true, "Logging In…");
    try {
      const result = await authClient.signIn({ ...formPayload(form), next: nextPath() });
      window.location.assign(result.redirect ?? "/account");
    } catch (error) {
      showFormError(form, error);
      setButtonPending(button, false);
    }
  });
  if (new URLSearchParams(location.search).get("reset") === "success") {
    const success = element("#login-success");
    if (success) {
      success.hidden = false;
      success.focus();
      history.replaceState({}, "", "/login");
    }
  }
}

function wireSignup() {
  const form = element("#signup-form");
  if (!form) return;
  wireFieldRecovery(form, (currentForm, options) => validateEmailField(currentForm) && validateStrongPasswordForm(currentForm, options));
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    const emailValid = validateEmailField(form);
    const passwordValid = validateStrongPasswordForm(form, { focus: true });
    if (!emailValid || !passwordValid) return;
    const button = element('button[type="submit"]', form);
    setButtonPending(button, true, "Creating Account…");
    const payload = { ...formPayload(form), next: nextPath() };
    try {
      const result = await authClient.signUp(payload);
      safeSessionSet("roleradar.verificationEmail", payload.email);
      window.location.assign(result.redirect ?? "/verify-email");
    } catch (error) {
      showFormError(form, error);
      setButtonPending(button, false);
    }
  });
}

function cooldownUntil() {
  const value = Number.parseInt(safeSessionGet("roleradar.resendAvailableAt") ?? "", 10);
  return Number.isFinite(value) ? value : 0;
}

function startResendCooldown(button, seconds) {
  const until = Date.now() + seconds * 1_000;
  safeSessionSet("roleradar.resendAvailableAt", String(until));
  if (resendTimer) clearInterval(resendTimer);
  const update = () => {
    const remaining = Math.max(0, Math.ceil((until - Date.now()) / 1_000));
    const label = element(".button-label", button);
    const status = element("#verification-cooldown-status");
    if (remaining > 0) {
      button.disabled = true;
      if (label) label.textContent = `Resend Available in ${numberFormatter.format(remaining)}s`;
      if (status && remaining === seconds) status.textContent = `Resend available in ${numberFormatter.format(remaining)} seconds.`;
    } else {
      button.disabled = false;
      if (label) label.textContent = button.dataset.readyLabel;
      if (status) status.textContent = "You can resend another verification email now.";
      if (resendTimer) clearInterval(resendTimer);
      resendTimer = null;
    }
  };
  update();
  resendTimer = setInterval(update, 1_000);
}

function wireVerification() {
  const form = element("#verification-form");
  if (!form) return;
  const email = inputNamed(form, "email");
  const rememberedEmail = safeSessionGet("roleradar.verificationEmail");
  if (email && rememberedEmail) email.value = rememberedEmail;
  wireFieldRecovery(form, validateEmailField);
  const status = element("#verification-status");
  const query = new URLSearchParams(location.search);
  if (query.get("status") === "error" && status) {
    const reason = query.get("reason");
    const title = element("[data-status-title]", status);
    const copy = element("[data-status-copy]", status);
    status.classList.add("system-message-error");
    if (title) title.textContent = reason === "expired" ? "Verification Link Expired" : "Verification Link Invalid";
    if (copy) copy.textContent = "Request a new verification email below, then use the most recent link.";
    status.hidden = false;
    status.focus();
  }
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    if (!validateEmailField(form, { focus: true })) return;
    const button = element('button[type="submit"]', form);
    setButtonPending(button, true, "Sending Verification Email…");
    try {
      const result = await authClient.resendVerification(email.value.trim());
      safeSessionSet("roleradar.verificationEmail", email.value.trim());
      if (status) {
        const title = element("[data-status-title]", status);
        const copy = element("[data-status-copy]", status);
        status.className = "system-message system-message-success";
        if (title) title.textContent = "Verification Email Sent";
        if (copy) copy.textContent = result.message;
        status.hidden = false;
        status.focus();
      }
      setButtonPending(button, false);
      startResendCooldown(button, result.cooldownSeconds ?? 60);
    } catch (error) {
      showFormError(form, error);
      setButtonPending(button, false);
    }
  });
  const button = element('button[type="submit"]', form);
  const remaining = Math.ceil((cooldownUntil() - Date.now()) / 1_000);
  if (button && remaining > 0) startResendCooldown(button, remaining);
}

function wireForgotPassword() {
  const form = element("#forgot-form");
  if (!form) return;
  wireFieldRecovery(form, validateEmailField);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    if (!validateEmailField(form, { focus: true })) return;
    const button = element('button[type="submit"]', form);
    setButtonPending(button, true, "Sending Reset Instructions…");
    try {
      await authClient.requestPasswordReset(inputNamed(form, "email").value.trim());
      element("#forgot-request-state").hidden = true;
      element("#forgot-alternate").hidden = true;
      const success = element("#forgot-success-state");
      success.hidden = false;
      element("#forgot-view")?.setAttribute("aria-labelledby", "forgot-success-title");
      element("h1", success)?.focus();
    } catch (error) {
      showFormError(form, error);
      setButtonPending(button, false);
    }
  });
}

function showResetState(name) {
  const labelId = {
    loading: "reset-loading-title",
    invalid: "reset-invalid-title",
    unavailable: "reset-unavailable-title",
    form: "reset-title",
    success: "reset-success-title",
  }[name] ?? "reset-title";
  element("#reset-view")?.setAttribute("aria-labelledby", labelId);
  element("#reset-loading-state").hidden = name !== "loading";
  element("#reset-invalid-state").hidden = name !== "invalid";
  element("#reset-unavailable-state").hidden = name !== "unavailable";
  element("#reset-form-state").hidden = name !== "form";
  element("#reset-success-state").hidden = name !== "success";
  if (name === "invalid") element("#reset-invalid-state h1")?.focus();
  if (name === "unavailable") element("#reset-unavailable-state h1")?.focus();
  if (name === "success") element("#reset-success-state h1")?.focus();
}

function wireResetPassword() {
  const form = element("#reset-form");
  if (!form) return;
  wireFieldRecovery(form, validateStrongPasswordForm);
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    clearFormErrors(form);
    if (!validateStrongPasswordForm(form, { focus: true })) return;
    const button = element('button[type="submit"]', form);
    setButtonPending(button, true, "Updating Password…");
    try {
      await authClient.updatePassword(formPayload(form));
      safeSessionRemove("roleradar.verificationEmail");
      showResetState("success");
      let remaining = 3;
      const countdown = element("#reset-countdown");
      const timer = setInterval(() => {
        remaining -= 1;
        if (countdown) countdown.textContent = numberFormatter.format(Math.max(0, remaining));
        if (remaining <= 0) {
          clearInterval(timer);
          window.location.replace("/login?reset=success");
        }
      }, 1_000);
    } catch (error) {
      showFormError(form, error);
      setButtonPending(button, false);
    }
  });
}

function wireAccount() {
  const logout = element("#account-logout");
  const message = element("#account-message");
  if (logout) {
    wireLogoutButton(logout, { redirectTo: "/" });
    logout.addEventListener("roleradar:autherror", (event) => {
      const text = message ? element("[data-form-message-text]", message) : null;
      if (message && text) {
      text.textContent = event.detail?.message ?? "Scout could not log you out. Try again.";
        message.hidden = false;
        message.focus();
      }
    });
  }
  if (new URLSearchParams(location.search).get("verified") === "1") {
    const verified = element("#account-verified-message");
    if (verified) {
      verified.hidden = false;
      verified.focus();
      history.replaceState({}, "", "/account");
    }
  }
}

function enableReadyButtons() {
  for (const button of document.querySelectorAll("[data-ready-label]")) {
    button.disabled = false;
    const label = element(".button-label", button);
    if (label) label.textContent = button.dataset.readyLabel;
  }
}

function showAvailabilityError(options = {}) {
  const message = element("#configuration-message");
  if (message) {
    const title = element("strong", message);
    const copy = element("span", message);
    if (options.configured === false) {
      if (title) title.textContent = "Account Access Is Not Configured";
      if (copy) copy.textContent = "This Scout server needs its Supabase environment variables before account forms can be used.";
    } else {
      if (title) title.textContent = "Account Access Is Temporarily Unavailable";
      if (copy) copy.textContent = options.message ?? "Scout could not reach the authentication service. Check your connection and try again.";
    }
    message.hidden = false;
  }
  for (const button of document.querySelectorAll("[data-ready-label]")) {
    button.disabled = true;
    const label = element(".button-label", button);
    if (label) label.textContent = "Account Access Unavailable";
  }
}

async function initialize() {
  wirePasswordControls();
  wireLogin();
  wireSignup();
  wireVerification();
  wireForgotPassword();
  wireResetPassword();
  wireAccount();

  try {
    const state = await authClient.bootstrap();
    if (!state.configured) {
      showAvailabilityError({ configured: false });
    } else {
      enableReadyButtons();
    }

    if (state.status === "authenticated" && route !== "/reset-password" && route !== "/account") {
      window.location.replace(route === "/verify-email" ? "/account?verified=1" : nextPath());
      return;
    }

    if (route === "/reset-password") {
      showResetState(!state.configured ? "unavailable" : state.status === "authenticated" && state.recoveryReady ? "form" : "invalid");
    }
    if (route === "/account") {
      if (state.status !== "authenticated") {
        window.location.replace(`/login?next=${encodeURIComponent("/account")}`);
        return;
      }
      const email = element("#account-email");
      if (email) email.textContent = state.user?.email ?? "Unavailable";
    }
  } catch (error) {
    showAvailabilityError({ configured: true, message: error?.message });
    if (route === "/reset-password") showResetState("unavailable");
  } finally {
    element("#auth-app")?.setAttribute("aria-busy", "false");
  }
}

window.addEventListener("pagehide", () => {
  if (resendTimer) clearInterval(resendTimer);
});

void initialize();
