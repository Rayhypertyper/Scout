// Compile the scheduler independently when unrelated app type errors block a full build.
// Existing dist/src/index.js and its dependencies must already be built.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import process from 'node:process';
import ts from 'typescript';
if (!existsSync('dist/src/index.js')) throw new Error('Build the crawler before building its scheduler.');
mkdirSync('dist/src/config', { recursive: true });
for (const [sourcePath, outputPath] of [
  ['src/config/macPowerState.ts', 'dist/src/config/macPowerState.js'],
  ['src/scheduler.ts', 'dist/src/scheduler.js'],
]) {
  const result = ts.transpileModule(readFileSync(sourcePath, 'utf8'), {
    compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
    reportDiagnostics: true,
  });
  const errors = result.diagnostics?.filter((diagnostic) => diagnostic.category === ts.DiagnosticCategory.Error) ?? [];
  if (errors.length > 0) {
    throw new Error(ts.formatDiagnosticsWithColorAndContext(errors, {
      getCurrentDirectory: () => process.cwd(),
      getCanonicalFileName: (fileName) => fileName,
      getNewLine: () => '\n',
    }));
  }
  writeFileSync(outputPath, result.outputText);
}

// Smoke-load the compiled entrypoint without loading the user's project .env.
process.env.NODE_ENV = 'test';
const scheduler = await import('../dist/src/scheduler.js');
if (typeof scheduler.startScheduler !== 'function') throw new Error('Compiled scheduler did not export startScheduler.');
const { readMacPowerState } = await import('../dist/src/config/macPowerState.js');
const powerState = process.platform === 'darwin' ? await readMacPowerState() : null;
if (typeof readMacPowerState !== 'function') throw new Error('Compiled scheduler helper did not export readMacPowerState.');
process.stdout.write(`[SCHEDULER BUILD] Compiled scheduler import passed${powerState ? `; macOS power probe: ${powerState}.` : '.'}\n`);
