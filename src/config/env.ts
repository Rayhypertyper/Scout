import { resolve } from "node:path";
import process from "node:process";

const BOOTSTRAP_STATE = Symbol.for("internshipmatic.project-env-loaded");
const state = globalThis as unknown as { [key: symbol]: boolean | undefined };

function isMissingEnvFile(error: unknown): boolean {
  return typeof error === "object" && error !== null && "code" in error && error.code === "ENOENT";
}

/**
 * Load the repository's optional .env before configuration modules capture
 * process.env. Shell and host-provided values keep precedence because Node's
 * process.loadEnvFile only sets variables that are currently unset.
 */
if (!state[BOOTSTRAP_STATE]) {
  state[BOOTSTRAP_STATE] = true;
  // Test runs must remain hermetic: fixture subprocesses opt back in with a
  // non-test NODE_ENV and a temporary INTERNSHIPMATIC_ROOT.
  if (process.env.NODE_ENV !== "test") {
    const projectRoot = resolve(process.env.INTERNSHIPMATIC_ROOT ?? process.cwd());
    try {
      process.loadEnvFile(resolve(projectRoot, ".env"));
    } catch (error) {
      if (!isMissingEnvFile(error)) {
        // Avoid echoing parser/runtime errors because they may contain .env
        // details. Do not make an optional local file expose secret values or
        // prevent Scout from starting when it is malformed or unreadable.
        console.warn("[ENV] Unable to load the project .env file; check its syntax and permissions.");
      }
    }
  }
}
