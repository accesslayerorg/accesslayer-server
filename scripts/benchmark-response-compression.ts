// scripts/benchmark-response-compression.ts
// Compares wire size and latency for list endpoints with and without
// compression (#1343). Targets a running server; it does not start one.
//
// Usage:
//   BASE_URL=http://localhost:3000 pnpm exec ts-node --transpile-only \
//     scripts/benchmark-response-compression.ts /api/v1/keys /api/v1/trades
//
// Options (env): RUNS (default 20), TIMEOUT_MS (default 10000).
// Output is a markdown table so it can be pasted into the PR description.

const DEFAULT_RUNS = 20;
const DEFAULT_TIMEOUT_MS = 10_000;

type Encoding = 'identity' | 'gzip' | 'br';

interface Sample {
   bytes: number;
   ms: number;
   status: number;
   contentEncoding: string | null;
}

function median(values: number[]): number {
   if (values.length === 0) return 0;
   const sorted = [...values].sort((a, b) => a - b);
   const mid = Math.floor(sorted.length / 2);
   return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

async function sample(url: string, encoding: Encoding, timeoutMs: number): Promise<Sample> {
   const controller = new AbortController();
   const timer = setTimeout(() => controller.abort(), timeoutMs);
   const started = performance.now();
   try {
      const res = await fetch(url, {
         headers: { 'Accept-Encoding': encoding, Accept: 'application/json' },
         signal: controller.signal,
      });
      // Drain the body so the timing includes the full transfer.
      await res.arrayBuffer();
      const ms = performance.now() - started;
      // Content-Length is the encoded size on the wire. fetch decodes the body
      // itself, so the decoded arrayBuffer length would hide the saving.
      const header = res.headers.get('content-length');
      return {
         bytes: header ? Number(header) : 0,
         ms,
         status: res.status,
         contentEncoding: res.headers.get('content-encoding'),
      };
   } finally {
      clearTimeout(timer);
   }
}

async function measure(url: string, encoding: Encoding, runs: number, timeoutMs: number) {
   const samples: Sample[] = [];
   for (let i = 0; i < runs; i++) {
      samples.push(await sample(url, encoding, timeoutMs));
   }
   return {
      bytes: median(samples.map(s => s.bytes)),
      ms: median(samples.map(s => s.ms)),
      status: samples[0]?.status ?? 0,
      contentEncoding: samples[0]?.contentEncoding ?? null,
   };
}

async function main(): Promise<void> {
   const baseUrl = process.env.BASE_URL;
   const paths = process.argv.slice(2);
   if (!baseUrl || paths.length === 0) {
      console.error('Set BASE_URL and pass one or more paths, e.g. /api/v1/keys');
      process.exit(1);
   }

   const runs = Number(process.env.RUNS ?? DEFAULT_RUNS);
   const timeoutMs = Number(process.env.TIMEOUT_MS ?? DEFAULT_TIMEOUT_MS);

   console.log('| Endpoint | Encoding | Median bytes | Median ms | Status |');
   console.log('| --- | --- | ---: | ---: | ---: |');

   for (const path of paths) {
      const url = new URL(path, baseUrl).toString();
      const baseline = await measure(url, 'identity', runs, timeoutMs);
      console.log(`| ${path} | identity | ${baseline.bytes} | ${baseline.ms.toFixed(1)} | ${baseline.status} |`);

      for (const encoding of ['gzip', 'br'] as const) {
         const result = await measure(url, encoding, runs, timeoutMs);
         const saving =
            baseline.bytes > 0
               ? ` (${(((baseline.bytes - result.bytes) / baseline.bytes) * 100).toFixed(1)}% smaller)`
               : '';
         console.log(
            `| ${path} | ${result.contentEncoding ?? 'none'} | ${result.bytes}${saving} | ${result.ms.toFixed(1)} | ${result.status} |`
         );
      }
   }
}

main().catch(error => {
   console.error(error);
   process.exit(1);
});
