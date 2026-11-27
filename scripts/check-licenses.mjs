#!/usr/bin/env node
// scripts/check-licenses.mjs
// Fails the build when a production dependency carries a license outside the
// allowlist in license-policy.json (supply chain guard, see
// docs/security/supply-chain.md).
//
// Input is the JSON produced by license-checker:
//   pnpm dlx license-checker-rseidelsohn@5.0.1 --production --json > licenses.json
//   node scripts/check-licenses.mjs licenses.json [license-policy.json] [--today YYYY-MM-DD]
//
// Exceptions in the policy are dated. An expired exception is a violation again,
// so a reviewed exception cannot silently live forever.

import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';

/**
 * Tokenises and evaluates an SPDX-style expression such as
 * "(MIT OR Apache-2.0) AND BSD-3-Clause" against an allowlist.
 * Unknown or empty expressions evaluate to false.
 */
export function isLicenseExpressionAllowed(expression, allowed) {
   if (typeof expression !== 'string' || expression.trim() === '') return false;

   const tokens = expression.match(/\(|\)|[^\s()]+/g) ?? [];
   let position = 0;

   const peek = () => tokens[position];
   const take = () => tokens[position++];

   function parseFactor() {
      const token = take();
      if (token === '(') {
         const value = parseOr();
         if (take() !== ')') return false;
         return value;
      }
      if (token === undefined || token === ')' || /^(AND|OR)$/i.test(token)) return false;
      // Trailing '*' or '+' is an SPDX-ish marker for "or later"; drop it.
      return allowed.has(token.replace(/[*+]$/, ''));
   }

   function parseAnd() {
      let value = parseFactor();
      while (peek() && /^AND$/i.test(peek())) {
         take();
         const right = parseFactor();
         value = value && right;
      }
      return value;
   }

   function parseOr() {
      let value = parseAnd();
      while (peek() && /^OR$/i.test(peek())) {
         take();
         const right = parseAnd();
         value = value || right;
      }
      return value;
   }

   const result = parseOr();
   return position === tokens.length && result;
}

function normaliseLicenses(licenses) {
   if (Array.isArray(licenses)) return licenses.join(' OR ');
   return typeof licenses === 'string' ? licenses : '';
}

/**
 * Returns violations for a license-checker report. Each violation is
 * { name, license, reason }.
 */
export function findLicenseViolations(report, policy, today = new Date()) {
   const allowed = new Set(policy.allowed ?? []);
   const exceptions = policy.exceptions ?? [];
   const violations = [];

   for (const [name, info] of Object.entries(report)) {
      const license = normaliseLicenses(info?.licenses);
      if (isLicenseExpressionAllowed(license, allowed)) continue;

      // License-checker keys are "name@version"; exceptions are per package name.
      const packageName = name.replace(/@[^@/]+$/, '');
      const exception = exceptions.find(entry => entry.package === packageName);
      if (exception) {
         if (exception.license && exception.license !== license) {
            violations.push({
               name,
               license,
               reason: `exception covers license "${exception.license}" only`,
            });
            continue;
         }
         const expires = new Date(`${exception.expires}T23:59:59Z`);
         if (Number.isNaN(expires.getTime()) || expires < today) {
            violations.push({ name, license, reason: `exception expired on ${exception.expires}` });
            continue;
         }
         continue;
      }

      violations.push({ name, license: license || 'UNKNOWN', reason: 'license not on the allowlist' });
   }

   return violations;
}

function parseTodayFlag(argv) {
   const index = argv.indexOf('--today');
   if (index === -1) return new Date();
   return new Date(`${argv[index + 1]}T00:00:00Z`);
}

function main() {
   const argv = process.argv.slice(2);
   const [reportPath, policyPath = 'license-policy.json'] = argv.filter(arg => !arg.startsWith('--') && !/^\d{4}-/.test(arg));
   if (!reportPath) {
      console.error('Usage: node scripts/check-licenses.mjs <licenses.json> [license-policy.json] [--today YYYY-MM-DD]');
      process.exit(2);
   }

   const report = JSON.parse(readFileSync(reportPath, 'utf8'));
   const policy = JSON.parse(readFileSync(policyPath, 'utf8'));
   const violations = findLicenseViolations(report, policy, parseTodayFlag(argv));

   for (const violation of violations) {
      console.error(
         `::error::Disallowed license for ${violation.name}: "${violation.license}" (${violation.reason})`
      );
   }

   if (violations.length > 0) {
      console.error(`${violations.length} dependency license violation(s). See license-policy.json.`);
      process.exit(1);
   }
   console.log(`Checked ${Object.keys(report).length} package(s). All licenses are allowed.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
   main();
}
