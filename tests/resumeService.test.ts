import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";

import { compileLatex } from "../src/resume/service.js";

const environmentKeys = [
  "PATH", "HOME", "LANG", "LC_ALL", "LC_CTYPE", "XDG_CACHE_HOME", "TMPDIR",
  "RESUME_TECTONIC_PATH", "TECTONIC_UNTRUSTED_MODE", "OPENAI_API_KEY", "AUTH_RECOVERY_SECRET",
  "AUTH_SITE_URL", "SUPABASE_URL", "SUPABASE_PUBLISHABLE_KEY", "SUPABASE_SERVICE_ROLE_KEY",
  "SCOUT_TEST_ARBITRARY_SECRET",
] as const;

function withoutMacOsRuntimeEnvironment(environment: Record<string, string | undefined>): Record<string, string | undefined> {
  // macOS injects this locale marker when a child process starts; it is not inherited through the allowlist.
  if (process.platform === "darwin") delete environment.__CF_USER_TEXT_ENCODING;
  return environment;
}

describe("resume Tectonic process environment", () => {
  it("passes only the explicit environment allowlist and returns the compiled PDF", async () => {
    const savedEnvironment = new Map(environmentKeys.map((key) => [key, process.env[key]]));
    const fixtureDirectory = mkdtempSync(join(tmpdir(), "scout-tectonic-fixture-"));
    const temporaryDirectory = join(fixtureDirectory, "tmp");
    const compilerPath = join(fixtureDirectory, "tectonic-fixture.mjs");
    const environmentRecordPath = join(fixtureDirectory, "received-environment.json");

    mkdirSync(temporaryDirectory);
    writeFileSync(compilerPath, `#!/usr/bin/env node
import { writeFileSync } from "node:fs";
import { join } from "node:path";
const args = process.argv.slice(2);
const outputIndex = args.indexOf("--outdir");
writeFileSync(${JSON.stringify(environmentRecordPath)}, JSON.stringify({ env: process.env, args }));
writeFileSync(join(args[outputIndex + 1], "resume.pdf"), "%PDF-1.7\\nfixture");
`, { mode: 0o700 });
    chmodSync(compilerPath, 0o700);

    try {
      process.env.PATH ||= dirname(process.execPath);
      process.env.HOME = join(fixtureDirectory, "home-first");
      process.env.LANG = "C.UTF-8";
      process.env.LC_ALL = "C";
      process.env.LC_CTYPE = "C.UTF-8";
      process.env.XDG_CACHE_HOME = join(fixtureDirectory, "cache-first");
      process.env.TMPDIR = temporaryDirectory;
      process.env.RESUME_TECTONIC_PATH = compilerPath;
      process.env.TECTONIC_UNTRUSTED_MODE = "0";
      process.env.OPENAI_API_KEY = "openai-secret";
      process.env.AUTH_RECOVERY_SECRET = "auth-secret";
      process.env.AUTH_SITE_URL = "https://auth.example.test";
      process.env.SUPABASE_URL = "https://supabase.example.test";
      process.env.SUPABASE_PUBLISHABLE_KEY = "supabase-public-test";
      process.env.SUPABASE_SERVICE_ROLE_KEY = "supabase-secret";
      process.env.SCOUT_TEST_ARBITRARY_SECRET = "arbitrary-secret";

      const pdf = await compileLatex("\\documentclass{article}\\begin{document}fixture\\end{document}");
      expect(pdf.subarray(0, 5).toString()).toBe("%PDF-");
      expect(pdf.toString()).toBe("%PDF-1.7\nfixture");

      const firstCall = JSON.parse(readFileSync(environmentRecordPath, "utf8")) as {
        env: Record<string, string | undefined>;
        args: string[];
      };
      expect(withoutMacOsRuntimeEnvironment(firstCall.env)).toEqual({
        PATH: process.env.PATH,
        HOME: join(fixtureDirectory, "home-first"),
        LANG: "C.UTF-8",
        LC_ALL: "C",
        LC_CTYPE: "C.UTF-8",
        XDG_CACHE_HOME: join(fixtureDirectory, "cache-first"),
        TMPDIR: temporaryDirectory,
        TECTONIC_UNTRUSTED_MODE: "1",
      });
      expect(firstCall.args).toContain("--untrusted");

      process.env.HOME = join(fixtureDirectory, "home-second");
      process.env.LANG = "C";
      delete process.env.LC_ALL;
      delete process.env.LC_CTYPE;
      delete process.env.XDG_CACHE_HOME;
      process.env.TECTONIC_UNTRUSTED_MODE = "0";

      await compileLatex("\\documentclass{article}\\begin{document}fixture\\end{document}");
      const secondCall = JSON.parse(readFileSync(environmentRecordPath, "utf8")) as {
        env: Record<string, string | undefined>;
      };
      expect(withoutMacOsRuntimeEnvironment(secondCall.env)).toEqual({
        PATH: process.env.PATH,
        HOME: join(fixtureDirectory, "home-second"),
        LANG: "C",
        TMPDIR: temporaryDirectory,
        TECTONIC_UNTRUSTED_MODE: "1",
      });
    } finally {
      for (const [key, value] of savedEnvironment) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      rmSync(fixtureDirectory, { recursive: true, force: true });
    }
  });
});
