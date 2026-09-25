import { execFile } from "node:child_process";
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { resumeSchema, renderLatex, tailorResume, type Resume, type ResumeRole } from "./tailor.js";

const exec = promisify(execFile);
let compiling = false;
export class ResumeError extends Error {
  constructor(public readonly status: number, message: string) { super(message); }
}
export async function readBaseResume(): Promise<Resume> {
  try {
    const data = await readFile(resolve(process.env.RESUME_BASE_PATH || "output/resume/base.json"), "utf8");
    return resumeSchema.parse(JSON.parse(data));
  } catch {
    throw new ResumeError(503, "The base resume is missing or invalid. Configure RESUME_BASE_PATH on the server.");
  }
}
export async function compileLatex(source: string): Promise<Buffer> {
  if (compiling) throw new ResumeError(429, "Another resume is being prepared. Please try again shortly.");
  compiling = true;
  let directory: string | undefined;
  try {
    directory = await mkdtemp(join(tmpdir(), "scout-resume-"));
    await writeFile(join(directory, "resume.tex"), source, { mode: 0o600 });
    let compiler = process.env.RESUME_TECTONIC_PATH || "tectonic";
    const local = resolve("output/resume/bin/tectonic");
    if (!process.env.RESUME_TECTONIC_PATH && await access(local).then(() => true, () => false)) compiler = local;
    await exec(compiler, ["-X", "compile", "--untrusted", "--outdir", directory, join(directory, "resume.tex")], {
      cwd: directory, timeout: 120_000, maxBuffer: 2 * 1024 * 1024,
      env: { ...process.env, TECTONIC_UNTRUSTED_MODE: "1" },
    });
    const pdf = await readFile(join(directory, "resume.pdf"));
    if (pdf.subarray(0, 5).toString() !== "%PDF-") throw new Error("Invalid PDF");
    return pdf;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      throw new ResumeError(503, "LaTeX is not installed. Install Tectonic or configure RESUME_TECTONIC_PATH on the server.");
    }
    throw new ResumeError(503, "The LaTeX PDF could not be compiled. Check the server's Tectonic installation and package access, then retry.");
  } finally {
    compiling = false;
    if (directory) await rm(directory, { recursive: true, force: true });
  }
}
export async function generateResume(base: Resume, role: ResumeRole): Promise<{ pdf: Buffer; filename: string; matches: number }> {
  const tailored = tailorResume(base, role);
  const pdf = await compileLatex(renderLatex(tailored.resume));
  const stem = `${base.name}-${role.company}-${role.title}`.normalize("NFKD").replace(/[^a-zA-Z0-9]+/g, "-").replace(/^-|-$/g, "").slice(0, 150);
  return { pdf, filename: `${stem || "tailored-resume"}.pdf`, matches: tailored.matchedSkills.length };
}
