// src/lib/log-linter.ts
// Scans serialised log lines for secret-like or personal data that the scrub
// layer should have removed. Used by the log linter test (see
// src/lib/__tests__/log-linter.test.ts) and runnable against captured logs.

export type LogLintRule =
   | 'email'
   | 'bearer-token'
   | 'jwt'
   | 'api-key'
   | 'stellar-seed'
   | 'secret-field'
   | 'wallet-address';

export interface LogLintFinding {
   /** 1-based line number within the scanned input. */
   line: number;
   rule: LogLintRule;
   /** The matched text. Secret-like matches are truncated so the report is safe to print. */
   match: string;
}

interface LintRuleDefinition {
   rule: LogLintRule;
   pattern: RegExp;
}

const RULES: LintRuleDefinition[] = [
   { rule: 'email', pattern: /[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g },
   { rule: 'bearer-token', pattern: /\bBearer\s+(?!\[REDACTED)[A-Za-z0-9\-._~+/]{8,}/g },
   { rule: 'jwt', pattern: /\beyJ[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}\.[A-Za-z0-9_-]{4,}/g },
   { rule: 'api-key', pattern: /\b(?:sk|pk|rk)_(?:live|test)_[A-Za-z0-9]{8,}\b/g },
   { rule: 'stellar-seed', pattern: /\bS[A-Z2-7]{55}\b/g },
   {
      // A JSON field whose name looks sensitive and whose value is not redacted.
      rule: 'secret-field',
      pattern:
         /"[A-Za-z_-]*(?:secret|password|passwd|token|apikey|api_key|authorization|cookie|passkey|credential)[A-Za-z_-]*"\s*:\s*"(?!\[REDACTED)[^"]+"/gi,
   },
   { rule: 'wallet-address', pattern: /\bG[A-Z2-7]{55}\b/g },
];

const MAX_MATCH_LENGTH = 24;

function safeMatch(rule: LogLintRule, text: string): string {
   // Never echo a full secret back into a report.
   const secretRules: LogLintRule[] = ['bearer-token', 'jwt', 'api-key', 'stellar-seed', 'secret-field'];
   if (secretRules.includes(rule)) {
      return text.slice(0, 8) + '…';
   }
   return text.length > MAX_MATCH_LENGTH ? text.slice(0, MAX_MATCH_LENGTH) + '…' : text;
}

/**
 * Lints one or more log lines and returns every rule violation found.
 * An empty array means the input is clean.
 */
export function lintLogLines(lines: string[]): LogLintFinding[] {
   const findings: LogLintFinding[] = [];

   lines.forEach((line, index) => {
      for (const { rule, pattern } of RULES) {
         pattern.lastIndex = 0;
         let match: RegExpExecArray | null;
         while ((match = pattern.exec(line)) !== null) {
            findings.push({ line: index + 1, rule, match: safeMatch(rule, match[0]) });
            if (match[0].length === 0) pattern.lastIndex++;
         }
      }
   });

   return findings;
}
