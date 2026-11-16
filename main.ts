// The entrypoint: bind a port, tell the grading env about it, and wait
// until the env says the trial is over.
//
//   1. MAKEFUN_ENV_URL names the env's origin. Without it there is nothing
//      to register with, so the process serves standalone on PORT instead
//      (a local run) and waits for SIGTERM.
//   2. With it, the server listens on an ephemeral port (never 8080: the
//      env owns that one), POSTs {"port": N} to $MAKEFUN_ENV_URL/register,
//      then polls GET $MAKEFUN_ENV_URL/done until it answers {"done": true}.
//   3. Then the server closes and the process exits 0.
//
// The server itself lives in src/http.ts; this file is only the lifecycle.

import { createForge } from './src/http.ts';

const ENV_URL = (process.env.MAKEFUN_ENV_URL ?? '').replace(/\/+$/, '');

const REQUEST_TIMEOUT_MS = 30_000;
const RETRY_INITIAL_MS = 250;
const RETRY_MAX_MS = 2_000;

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function retryDelay(attempt: number): number {
  return Math.min(RETRY_MAX_MS, RETRY_INITIAL_MS * 2 ** Math.min(attempt, 8));
}

/** POST the bound port until the env accepts it (200, or 409 when another entry won). */
async function register(envUrl: string, port: number): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
      if (res.status === 200 || res.status === 409) return;
      if (res.status === 400 || res.status === 405) {
        throw new Error(`register answered HTTP ${res.status}: ${await res.text()}`);
      }
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('register answered HTTP ')) throw err;
    }
    await sleep(retryDelay(attempt));
  }
}

/** Poll GET /done until it answers {"done": true}; never return before that. */
async function waitForDone(envUrl: string): Promise<void> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      const res = await fetch(`${envUrl}/done`, { signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
      if (res.ok) {
        const body = (await res.json()) as { done?: unknown };
        if (body.done === true) return;
      }
    } catch {
      // The env is not answering yet: it is not done, so poll again.
    }
    await sleep(retryDelay(attempt));
  }
}

async function main(): Promise<void> {
  const server = createForge(process.env);
  if (ENV_URL === '') {
    // Standalone mode: serve on PORT (default 18080) until SIGTERM.
    const port = Number(process.env.PORT ?? 18080);
    await new Promise<void>((resolve) => {
      server.listen(port, '127.0.0.1', () => {
        process.stderr.write(`[forge] listening on 127.0.0.1:${port} (standalone, no MAKEFUN_ENV_URL)\n`);
        resolve();
      });
    });
    await new Promise<void>((resolve) => {
      process.on('SIGTERM', () => resolve());
      process.on('SIGINT', () => resolve());
    });
    server.close();
    return;
  }
  const port = await new Promise<number>((resolve, reject) => {
    server.listen(0, () => {
      const address = server.address();
      if (address === null || typeof address === 'string') {
        reject(new Error('the server did not bind a port'));
        return;
      }
      resolve(address.port);
    });
    server.on('error', reject);
  });
  await register(ENV_URL, port);
  await waitForDone(ENV_URL);
  await new Promise<void>((resolve) => server.close(() => resolve()));
  process.exit(0);
}

main().catch((error: unknown) => {
  process.stderr.write(`[forge] fatal: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exit(1);
});
