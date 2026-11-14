// Entry point: the harness lifecycle for the git forge.
//
// The forge itself lives in app.ts — createApp builds the server and owns
// every surface it serves. This file only performs the short dance the trial
// env expects, then gets out of the way:
//
//   1. Read MAKEFUN_ENV_URL. With no env to talk to there is nothing to
//      register with, so the program fails at once with exit code 1.
//   2. Build the server and listen on port 0, letting the kernel pick a
//      free port. Port 8080 belongs to the env and is never bound here.
//   3. POST {"port": <chosen>} to $MAKEFUN_ENV_URL/register. A 409 means
//      another entry already holds the slot; the program then simply waits
//      alongside it instead of failing. Any other failure is retried with
//      a delay that doubles each time.
//   4. GET $MAKEFUN_ENV_URL/done again and again. The env answers
//      {"done": false} while the suite runs and {"done": true} once it has
//      finished and written its export; a failed or garbled answer backs
//      off exponentially instead of hammering the env.
//   5. Close the server and exit 0.
//
// No dependencies, no git binary, no model calls: only the standard library
// (fetch, setTimeout) plus the server app.ts builds.

import { createApp } from './app.ts';

/** Wait before the first retry of a failed env call. */
const FIRST_RETRY_MS = 100;
/**
 * The longest gap between two retries of a failed env call. Two seconds
 * keeps a recovering env re-checked promptly instead of leaving the forge
 * unregistered while the boot budget runs down.
 */
const MAX_RETRY_MS = 2_000;
/** How many times registration is attempted before giving up. */
const MAX_REGISTER_ATTEMPTS = 60;
/** Pause between two polls that both answered {"done": false}. */
const POLL_PAUSE_MS = 250;

/** The server createApp builds, named without importing node:http here. */
type ForgeServer = ReturnType<typeof createApp>;

function sleep(ms: number): Promise<void> {
  return new Promise<void>((resolve) => {
    setTimeout(resolve, ms);
  });
}

/** The env's origin, or exit 1 at once when it is not set. */
function envOrigin(): string {
  const origin = process.env.MAKEFUN_ENV_URL;
  if (origin === undefined || origin === '') {
    process.exit(1);
  }
  return origin.replace(/\/+$/, '');
}

/** Bind the server to a kernel-chosen port and report which one it got. */
async function bindEphemeralPort(server: ForgeServer): Promise<number> {
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, () => resolve());
  });
  const address = server.address();
  if (typeof address === 'object' && address !== null) {
    return address.port;
  }
  return 0;
}

/**
 * Tell the env which port the forge listens on. Returns true once the env
 * has the port (a 409 also counts: another entry already registered, so
 * there is nothing more to claim); false when the attempts run out with
 * no usable answer.
 */
async function registerPort(origin: string, port: number): Promise<boolean> {
  let delay = FIRST_RETRY_MS;
  for (let attempt = 1; attempt <= MAX_REGISTER_ATTEMPTS; attempt += 1) {
    try {
      const response = await fetch(`${origin}/register`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port }),
      });
      await response.text();
      if (response.ok || response.status === 409) {
        return true;
      }
    } catch {
      // A refused socket or dropped connection: wait, then try again.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
  return false;
}

/**
 * Poll GET /done until the env answers {"done": true}. Healthy "not yet"
 * answers are followed by a short pause; failed ones back off
 * exponentially so a struggling env is not hammered.
 */
async function waitForDone(origin: string): Promise<void> {
  let delay = FIRST_RETRY_MS;
  for (;;) {
    try {
      const response = await fetch(`${origin}/done`);
      if (response.ok) {
        const body = (await response.json()) as { done?: unknown };
        if (body.done === true) {
          return;
        }
        delay = FIRST_RETRY_MS;
        await sleep(POLL_PAUSE_MS);
        continue;
      }
    } catch {
      // A failed request or an unreadable answer: back off, then retry.
    }
    await sleep(delay);
    delay = Math.min(delay * 2, MAX_RETRY_MS);
  }
}

/** Close the server, waiting until its sockets are released. */
async function closeServer(server: ForgeServer): Promise<void> {
  await new Promise<void>((resolve) => {
    server.close(() => resolve());
  });
}

async function run(): Promise<void> {
  const origin = envOrigin();
  const server = createApp();
  const port = await bindEphemeralPort(server);
  const registered = await registerPort(origin, port);
  if (!registered) {
    await closeServer(server);
    process.exit(1);
  }
  await waitForDone(origin);
  await closeServer(server);
}

try {
  await run();
} catch {
  process.exit(1);
}
process.exit(0);
