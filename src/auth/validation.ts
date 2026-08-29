import { z } from "zod";

import { AuthHttpError } from "./http.js";

const emailSchema = z.string().trim().min(1).max(254).email();
const passwordSchema = z.string()
  .min(10)
  .max(128)
  .refine((value) => /\p{L}/u.test(value), "Add at least 1 letter.")
  .refine((value) => /\p{N}/u.test(value), "Add at least 1 number.");

function requiredString(body: Record<string, unknown>, field: string): string {
  const value = body[field];
  if (typeof value !== "string") {
    throw new AuthHttpError(422, "FIELD_REQUIRED", `Enter your ${field === "confirmPassword" ? "password again" : field}.`, { field });
  }
  return value;
}

export function normalizedEmail(body: Record<string, unknown>): string {
  const value = requiredString(body, "email");
  const result = emailSchema.safeParse(value);
  if (!result.success) {
    throw new AuthHttpError(422, "INVALID_EMAIL", "Enter a valid email address.", { field: "email" });
  }
  return result.data.toLowerCase();
}

export function strongPassword(body: Record<string, unknown>): string {
  const value = requiredString(body, "password");
  const result = passwordSchema.safeParse(value);
  if (!result.success) {
    const issue = result.error.issues[0];
    const message = issue?.code === "too_small"
      ? "Use at least 10 characters."
      : issue?.code === "too_big"
        ? "Use no more than 128 characters."
        : issue?.message ?? "Use at least 10 characters, including a letter and a number.";
    throw new AuthHttpError(422, "WEAK_PASSWORD", message, { field: "password" });
  }
  return result.data;
}

export function confirmedStrongPassword(body: Record<string, unknown>): string {
  const password = strongPassword(body);
  const confirmation = requiredString(body, "confirmPassword");
  if (password !== confirmation) {
    throw new AuthHttpError(422, "PASSWORD_MISMATCH", "The passwords do not match yet.", { field: "confirmPassword" });
  }
  return password;
}

export function loginPassword(body: Record<string, unknown>): string {
  const value = requiredString(body, "password");
  if (value.length === 0) throw new AuthHttpError(422, "FIELD_REQUIRED", "Enter your password.", { field: "password" });
  if (value.length > 1_024) throw new AuthHttpError(422, "INVALID_PASSWORD", "The password is too long.", { field: "password" });
  return value;
}
