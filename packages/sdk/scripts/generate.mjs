import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const pkgDir = path.resolve(__dirname, '..');
const root = path.resolve(pkgDir, '../..');
const specPath = path.join(root, 'docs/openapi.json');
const outPath = path.join(pkgDir, 'src/generated/schema.ts');
const check = process.argv.includes('--check');

execFileSync('pnpm', ['exec', 'openapi-typescript', specPath, '-o', outPath], {
  cwd: root,
  stdio: 'inherit',
});

if (check) {
  const diff = execFileSync('git', ['diff', '--name-only', '--', outPath], {
    cwd: root,
    encoding: 'utf8',
  }).trim();
  if (diff) {
    console.error(`Generated SDK schema is out of date: ${diff}`);
    process.exit(1);
  }
}

const generated = readFileSync(outPath, 'utf8');
if (!generated.includes('export interface paths')) {
  throw new Error('Generated schema missing paths interface');
}
