#!/usr/bin/env node
// scripts/check-audit-exceptions.mjs
// Fails CI on high or critical advisories unless a reviewed, dated exception
// exists in security/audit-exceptions.json (supply chain guard, see
// docs/security/supply-chain.md).
//
// Input is the JSON from `pnpm audit --json` (pnpm 10):
//   pnpm audit --json > audit.json || true
//   node scripts/check-audit-exceptions.mjs audit.json [security/audit-exceptions.json] [--today YYYY-MM-DD]
//
// Exceptions are never open-ended: each entry needs a reason, an approver and
// an expiry date. An expired exception stops suppressing its advisory.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

const BLOCKING_SEVERITIES = new Set(['high', 'critical']);

/** Identifiers an advisory can be referred to by. */
export function advisoryIdentifiers(advisory) {
   const ids = new Set();
   if (advisory.github_advisory_id) ids.add(advisory.github_advisory_id);
   for (const cve of advisory.cves ?? []) ids.add(cve);
   if (advisory.id !== undefined) ids.add(String(advisory.id));
   return ids;
}

/**
 * Validates exceptions and returns the blocking advisories that are not
 * covered by a current exception. Also returns configuration errors.
 */
export function evaluateAudit(auditReport, exceptions, today = new Date()) {
   const errors = [];
   const active = new Set();

   for (const entry of exceptions) {
      if (!entry.id || !entry.reason || !entry.approvedBy || !entry.expires) {
         errors.push(`exception ${entry.id ?? '(no id)'} must include id, reason, approvedBy and expires`);
         continue;
      }
      const expires = new Date(`${entry.expires}T23:59:59Z`);
      if (Number.isNaN(expires.getTime())) {
         errors.push(`exception ${entry.id} has an invalid expires date "${entry.expires}"`);
         continue;
      }
      if (expires < today) {
         errors.push(`exception ${entry.id} expired on ${entry.expires}; fix the advisory or renew with review`);
         continue;
      }
      active.add(entry.id);
   }

   const blocking = [];
   for (const advisory of Object.values(auditReport.advisories ?? {})) {
      if (!BLOCKING_SEVERITIES.has(advisory.severity)) continue;
      const covered = [...advisoryIdentifiers(advisory)].some(id => active.has(id));
      if (!covered) {
         blocking.push({
            id: advisory.github_advisory_id ?? String(advisory.id),
            severity: advisory.severity,
            module: advisory.module_name,
            title: advisory.title,
         });
      }
   }

   return { blocking, errors };
}

function parseTodayFlag(argv) {
   const index = argv.indexOf('--today');
   if (index === -1) return new Date();
   return new Date(`${argv[index + 1]}T00:00:00Z`);
}

function main() {
   const argv = process.argv.slice(2);
   const positional = argv.filter(arg => !arg.startsWith('--') && !/^\d{4}-/.test(arg));
   const [auditPath, exceptionsPath = 'security/audit-exceptions.json'] = positional;
   if (!auditPath) {
      console.error('Usage: node scripts/check-audit-exceptions.mjs <audit.json> [exceptions.json] [--today YYYY-MM-DD]');
      process.exit(2);
   }

   const auditReport = JSON.parse(readFileSync(auditPath, 'utf8'));
   const exceptions = JSON.parse(readFileSync(exceptionsPath, 'utf8'));
   const { blocking, errors } = evaluateAudit(auditReport, exceptions, parseTodayFlag(argv));

   for (const error of errors) {
      console.error(`::error file=${exceptionsPath}::${error}`);
   }
   for (const advisory of blocking) {
      console.error(
         `::error::${advisory.severity.toUpperCase()} advisory ${advisory.id} in ${advisory.module}: ${advisory.title}. ` +
            'Upgrade, or add a dated exception after review (see docs/security/supply-chain.md).'
      );
   }

   if (blocking.length > 0 || errors.length > 0) {
      process.exit(1);
   }
   console.log('No unexcepted high or critical advisories.');
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
   main();
}
