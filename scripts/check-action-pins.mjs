#!/usr/bin/env node
// scripts/check-action-pins.mjs
// Fails when a GitHub Actions `uses:` reference is not pinned to a full
// commit SHA (supply chain guard, see docs/security/supply-chain.md).
//
// Accepted forms:
//   uses: owner/repo@<40-hex-sha>            (pinned action)
//   uses: ./path/to/local-action             (local action, same repo)
//   uses: docker://image@sha256:<64-hex>    (digest-pinned container)
//
// Usage: node scripts/check-action-pins.mjs [workflowDir]

import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

const SHA_PIN = /@[0-9a-f]{40}(?:\s|$|#)/;
const DOCKER_DIGEST = /@sha256:[0-9a-f]{64}/;

/**
 * Returns the violations for one workflow file's text.
 * Each violation is { line, reference }.
 */
export function findUnpinnedActions(text) {
   const violations = [];
   text.split('\n').forEach((raw, index) => {
      const match = raw.match(/^\s*-?\s*uses:\s*(\S+)/);
      if (!match) return;

      const reference = match[1].replace(/['"]/g, '');
      if (reference.startsWith('./')) return;

      if (reference.startsWith('docker://')) {
         if (!DOCKER_DIGEST.test(reference)) {
            violations.push({ line: index + 1, reference });
         }
         return;
      }

      if (!SHA_PIN.test(`${reference} `)) {
         violations.push({ line: index + 1, reference });
      }
   });
   return violations;
}

function main() {
   const dir = process.argv[2] ?? path.join(process.cwd(), '.github', 'workflows');
   const files = readdirSync(dir).filter(name => /\.ya?ml$/.test(name));

   let failures = 0;
   for (const file of files) {
      const full = path.join(dir, file);
      for (const { line, reference } of findUnpinnedActions(readFileSync(full, 'utf8'))) {
         failures += 1;
         console.error(`::error file=${full},line=${line}::Action is not pinned to a commit SHA: ${reference}`);
      }
   }

   if (failures > 0) {
      console.error(`${failures} unpinned action reference(s). Pin each to a full commit SHA with a "# vN" comment.`);
      process.exit(1);
   }
   console.log(`All action references in ${files.length} workflow file(s) are pinned.`);
}

if (import.meta.url === pathToFileURL(process.argv[1]).href) {
   main();
}
