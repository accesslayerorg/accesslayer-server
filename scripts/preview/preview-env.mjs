#!/usr/bin/env node
// scripts/preview/preview-env.mjs
// Lifecycle for ephemeral per-pull-request preview environments (#1340).
// See docs/preview-environments.md for the operator guide.
//
// Commands:
//   provision --pr <n> --sha <sha>   create schema, migrate, seed, deploy, health-check, comment
//   teardown  --pr <n>               drop schema, call the deploy hook, remove label, comment
//   sweep     [--max-age-days 7]     tear down previews for closed PRs or inactive for N days
//
// Required environment (CI secrets / variables):
//   GH_TOKEN                      token with pull-requests: write
//   GITHUB_REPOSITORY             owner/name (set by GitHub Actions)
//   PREVIEW_DATABASE_ADMIN_URL    secret: Postgres URL with rights to create and drop schemas
//   PREVIEW_DEPLOY_HOOK_URL       secret: staging cluster endpoint that deploys a preview stack
//   PREVIEW_DEPLOY_TOKEN          secret: bearer token for the deploy hook
// Optional:
//   MAX_CONCURRENT_PREVIEWS       default 5
//   PREVIEW_SOROBAN_RPC_URL       shared test network RPC for previews
//   PREVIEW_ORACLE_MODE           default "mock" for deterministic prices
//
// The deploy hook receives the schema name and config, never database
// credentials. It must resolve the connection string from its own secret store.
// Contract: POST <hook> with JSON { action, pr, sha, schema, env } and an
// Authorization bearer token; reply 200 with JSON { url } for deploy.

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

export const PREVIEW_LABEL = 'preview';
export const COMMENT_MARKER = '<!-- preview-env -->';
const DEFAULT_MAX_CONCURRENT = 5;
const HEALTH_ATTEMPTS = 12;
const HEALTH_INTERVAL_MS = 10_000;

/** Schema name for a PR. Lowercase, digits and underscores only. */
export function schemaNameForPr(pr) {
   if (!Number.isInteger(pr) || pr <= 0) {
      throw new Error(`invalid pull request number: ${pr}`);
   }
   return `preview_pr_${pr}`;
}

/** Returns the database URL with `schema` selected, leaving credentials untouched. */
export function withSchema(databaseUrl, schema) {
   const url = new URL(databaseUrl);
   url.searchParams.set('schema', schema);
   return url.toString();
}

/** Builds the comment body. Contains only public URLs and status text. */
export function renderComment({ state, url, health, note }) {
   const lines = [COMMENT_MARKER, '### Preview environment', ''];
   if (state === 'deployed') {
      lines.push(`- URL: ${url}`);
      lines.push(`- Health: ${health}`);
      lines.push('- Seeded data: two preview creators (see docs/preview-environments.md)');
   } else if (state === 'removed') {
      lines.push('This preview was removed. Its database schema has been dropped.');
   } else if (state === 'limit') {
      lines.push(note);
   } else {
      lines.push(`Preview ${state}: ${note}`);
   }
   lines.push('', 'Debugging a failed preview: docs/preview-environments.md#debugging-a-failed-preview');
   return lines.join('\n');
}

function gh(args, { input } = {}) {
   return execFileSync('gh', args, {
      encoding: 'utf8',
      input,
      stdio: ['pipe', 'pipe', 'inherit'],
      env: process.env,
   }).trim();
}

function requireEnv(name) {
   const value = process.env[name];
   if (!value) throw new Error(`${name} is required`);
   return value;
}

function listPreviewPulls(state) {
   const raw = gh([
      'pr',
      'list',
      '--repo',
      requireEnv('GITHUB_REPOSITORY'),
      '--label',
      PREVIEW_LABEL,
      '--state',
      state,
      '--limit',
      '200',
      '--json',
      'number,state,updatedAt',
   ]);
   return JSON.parse(raw || '[]');
}

function upsertComment(pr, body) {
   const repo = requireEnv('GITHUB_REPOSITORY');
   // --paginate emits one result per page; the last non-empty line is the newest match.
   const existing = gh([
      'api',
      `repos/${repo}/issues/${pr}/comments`,
      '--paginate',
      '--jq',
      `.[] | select(.body | contains("${COMMENT_MARKER}")) | .id`,
   ])
      .split('\n')
      .filter(Boolean)
      .pop();

   if (existing) {
      gh(['api', '--method', 'PATCH', `repos/${repo}/issues/comments/${existing}`, '--field', `body=${body}`]);
   } else {
      gh(['api', '--method', 'POST', `repos/${repo}/issues/${pr}/comments`, '--field', `body=${body}`]);
   }
}

function setLabel(pr, present) {
   gh(['label', 'create', PREVIEW_LABEL, '--color', '0e8a16', '--description', 'Ephemeral preview environment', '--force', '--repo', requireEnv('GITHUB_REPOSITORY')]);
   const flag = present ? '--add-label' : '--remove-label';
   gh(['pr', 'edit', String(pr), flag, PREVIEW_LABEL, '--repo', requireEnv('GITHUB_REPOSITORY')]);
}

function runPrisma(args, databaseUrl) {
   execFileSync('pnpm', ['exec', 'prisma', ...args], {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: databaseUrl },
   });
}

async function callDeployHook(payload) {
   const response = await fetch(requireEnv('PREVIEW_DEPLOY_HOOK_URL'), {
      method: 'POST',
      headers: {
         'content-type': 'application/json',
         authorization: `Bearer ${requireEnv('PREVIEW_DEPLOY_TOKEN')}`,
      },
      body: JSON.stringify(payload),
   });
   if (!response.ok) {
      throw new Error(`deploy hook returned HTTP ${response.status} for action ${payload.action}`);
   }
   return response.json();
}

async function checkHealth(url) {
   for (let attempt = 1; attempt <= HEALTH_ATTEMPTS; attempt += 1) {
      try {
         const response = await fetch(`${url.replace(/\/$/, '')}/api/v1/health`);
         if (response.ok) return `healthy (HTTP ${response.status})`;
         if (attempt === HEALTH_ATTEMPTS) return `unhealthy (HTTP ${response.status})`;
      } catch (error) {
         if (attempt === HEALTH_ATTEMPTS) return `unreachable (${error.message})`;
      }
      await new Promise(resolve => setTimeout(resolve, HEALTH_INTERVAL_MS));
   }
   return 'unknown';
}

export async function provision({ pr, sha }) {
   const maxConcurrent = Number(process.env.MAX_CONCURRENT_PREVIEWS || DEFAULT_MAX_CONCURRENT);
   const openPreviews = listPreviewPulls('open');
   const alreadyLabelled = openPreviews.some(entry => entry.number === pr);
   const openCount = openPreviews.filter(entry => entry.number !== pr).length;

   if (!alreadyLabelled && openCount >= maxConcurrent) {
      const note = `Preview limit reached (${openCount}/${maxConcurrent} active). Close an existing preview PR or ask a maintainer to raise MAX_CONCURRENT_PREVIEWS.`;
      upsertComment(pr, renderComment({ state: 'limit', note }));
      console.log(note);
      return { state: 'limit' };
   }

   const schema = schemaNameForPr(pr);
   const adminUrl = requireEnv('PREVIEW_DATABASE_ADMIN_URL');
   const previewUrl = withSchema(adminUrl, schema);

   // Create the schema explicitly so migrations never touch the public schema.
   execFileSync('pnpm', ['exec', 'prisma', 'db', 'execute', '--url', adminUrl, '--stdin'], {
      input: `CREATE SCHEMA IF NOT EXISTS "${schema}";`,
      stdio: ['pipe', 'inherit', 'inherit'],
   });
   runPrisma(['migrate', 'deploy'], previewUrl);
   execFileSync('pnpm', ['exec', 'ts-node', '--transpile-only', 'scripts/seed-preview.ts'], {
      stdio: 'inherit',
      env: { ...process.env, DATABASE_URL: previewUrl },
   });

   const deployed = await callDeployHook({
      action: 'deploy',
      pr,
      sha,
      schema,
      env: {
         SOROBAN_RPC_URL: process.env.PREVIEW_SOROBAN_RPC_URL || '',
         ORACLE_MODE: process.env.PREVIEW_ORACLE_MODE || 'mock',
      },
   });
   if (!deployed.url) {
      throw new Error('deploy hook response did not include a url');
   }

   const health = await checkHealth(deployed.url);
   setLabel(pr, true);
   upsertComment(pr, renderComment({ state: 'deployed', url: deployed.url, health }));
   console.log(`preview for #${pr} at ${deployed.url} (${health})`);
   return { state: 'deployed', url: deployed.url, health };
}

export async function teardown({ pr, note = 'pull request closed' }) {
   const schema = schemaNameForPr(pr);
   const adminUrl = requireEnv('PREVIEW_DATABASE_ADMIN_URL');

   execFileSync('pnpm', ['exec', 'prisma', 'db', 'execute', '--url', adminUrl, '--stdin'], {
      input: `DROP SCHEMA IF EXISTS "${schema}" CASCADE;`,
      stdio: ['pipe', 'inherit', 'inherit'],
   });
   await callDeployHook({ action: 'teardown', pr, schema });
   setLabel(pr, false);
   upsertComment(pr, renderComment({ state: 'removed', note }));
   console.log(`removed preview for #${pr} (${note})`);
}

export async function sweep({ maxAgeDays = 7, now = Date.now() } = {}) {
   const cutoff = now - maxAgeDays * 24 * 60 * 60 * 1000;
   const targets = [];

   for (const entry of listPreviewPulls('closed')) {
      targets.push({ pr: entry.number, note: 'pull request closed' });
   }
   for (const entry of listPreviewPulls('open')) {
      if (Date.parse(entry.updatedAt) < cutoff) {
         targets.push({ pr: entry.number, note: `no activity for ${maxAgeDays} days` });
      }
   }

   for (const target of targets) {
      await teardown(target);
   }
   console.log(`sweep finished: ${targets.length} preview(s) removed`);
   return targets.length;
}

function parseArgs(argv) {
   const [command, ...rest] = argv;
   const options = {};
   for (let i = 0; i < rest.length; i += 2) {
      options[rest[i].replace(/^--/, '')] = rest[i + 1];
   }
   return { command, options };
}

async function main() {
   const { command, options } = parseArgs(process.argv.slice(2));
   switch (command) {
      case 'provision':
         await provision({ pr: Number(options.pr), sha: options.sha || requireEnv('HEAD_SHA') });
         break;
      case 'teardown':
         await teardown({ pr: Number(options.pr) });
         break;
      case 'sweep':
         await sweep({ maxAgeDays: Number(options['max-age-days'] || 7) });
         break;
      default:
         console.error('Usage: preview-env.mjs <provision|teardown|sweep> [--pr N] [--sha SHA] [--max-age-days N]');
         process.exit(2);
   }
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
   main().catch(error => {
      console.error(`preview command failed: ${error.message}`);
      process.exit(1);
   });
}
