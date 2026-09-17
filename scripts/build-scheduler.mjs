// Compile the scheduler independently when unrelated app type errors block a full build.
// Existing dist/src/index.js and its dependencies must already be built.
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import ts from 'typescript';
if (!existsSync('dist/src/index.js')) throw new Error('Build the crawler before building its scheduler.');
const result = ts.transpileModule(readFileSync('src/scheduler.ts', 'utf8'), {
  compilerOptions: { target: ts.ScriptTarget.ES2023, module: ts.ModuleKind.ESNext },
});
writeFileSync('dist/src/scheduler.js', result.outputText);
