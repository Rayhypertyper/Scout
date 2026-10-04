import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

const temporaryRoots: string[] = [];
const settingsUrl = pathToFileURL(resolve("src/config/settings.ts")).href;
const childCode = [
  "const settings = await import(" + JSON.stringify(settingsUrl) + ");",
  "console.log(JSON.stringify({",
  "  hasOpenAIKey: Boolean(process.env.OPENAI_API_KEY),",
  "  shellKeyRetained: process.env.OPENAI_API_KEY === 'fixture-shell-key',",
  "  outputDirectory: settings.DEFAULT_SETTINGS.outputDirectory,",
  "  databasePath: settings.DEFAULT_SETTINGS.databasePath",
  "}));",
].join("\n");

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function runIsolatedSettingsImport(
  projectRoot: string,
  environment: NodeJS.ProcessEnv = {},
  nodeEnvironment = "development",
): Record<string, unknown> {
  const childEnv: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: nodeEnvironment,
    INTERNSHIPMATIC_ROOT: projectRoot,
  };
  for (const name of ["OPENAI_API_KEY", "SCOUT_DATABASE_PATH", "SCOUT_OUTPUT_DIR", "SCOUT_LOG_LEVEL"]) {
    delete childEnv[name];
  }
  Object.assign(childEnv, environment);

  const result = spawnSync(process.execPath, ["--import", "tsx", "--input-type=module", "--eval", childCode], {
    cwd: resolve("."),
    env: childEnv,
    encoding: "utf8",
    timeout: 10_000,
  });
  if (result.error) throw result.error;
  expect(result.status, result.stderr).toBe(0);
  const lastLine = result.stdout.trim().split("\n").at(-1);
  return JSON.parse(lastLine ?? "null") as Record<string, unknown>;
}

function temporaryProjectRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "internshipmatic-env-bootstrap-"));
  temporaryRoots.push(root);
  return root;
}

describe("project .env startup bootstrap", () => {
  it("loads a private .env before settings constants are captured", () => {
    const root = temporaryProjectRoot();
    writeFileSync(join(root, ".env"), [
      "OPENAI_API_KEY=fixture-file-key",
      "SCOUT_OUTPUT_DIR=from-private-env",
      "SCOUT_DATABASE_PATH=from-private-env.db",
      "",
    ].join("\n"));

    const result = runIsolatedSettingsImport(root);

    expect(result).toMatchObject({
      hasOpenAIKey: true,
      outputDirectory: "from-private-env",
      databasePath: "from-private-env.db",
    });
  });

  it("preserves shell values while loading unset values from .env", () => {
    const root = temporaryProjectRoot();
    writeFileSync(join(root, ".env"), [
      "OPENAI_API_KEY=fixture-file-key",
      "SCOUT_OUTPUT_DIR=from-private-env",
      "SCOUT_DATABASE_PATH=from-private-env.db",
      "",
    ].join("\n"));

    const result = runIsolatedSettingsImport(root, {
      OPENAI_API_KEY: "fixture-shell-key",
      SCOUT_OUTPUT_DIR: "from-shell",
    });

    expect(result).toMatchObject({
      hasOpenAIKey: true,
      shellKeyRetained: true,
      outputDirectory: "from-shell",
      databasePath: "from-private-env.db",
    });
  });

  it("starts normally when the optional .env file is absent", () => {
    const result = runIsolatedSettingsImport(temporaryProjectRoot());

    expect(result).toMatchObject({
      hasOpenAIKey: false,
      outputDirectory: "./output",
      databasePath: "./output/internships.db",
    });
  });

  it("does not load .env from the test process environment", () => {
    const root = temporaryProjectRoot();
    writeFileSync(join(root, ".env"), "OPENAI_API_KEY=fixture-test-file-key\nSCOUT_OUTPUT_DIR=must-not-load\n");

    const result = runIsolatedSettingsImport(root, {}, "test");

    expect(result).toMatchObject({
      hasOpenAIKey: false,
      outputDirectory: "./output",
      databasePath: "./output/internships.db",
    });
  });
});
