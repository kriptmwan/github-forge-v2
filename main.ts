// main.ts — entrypoint for the github forge bot (v2).
//
// This file owns only the process lifecycle: start the forge server on
// an ephemeral port, announce that port to the make.fun environment
// service, and keep running until the environment reports the trial
// is finished. The forge itself — REST, GraphQL, MCP and git smart
// HTTP — lives in app.ts and is not touched here.

import { createApp } from "./app.ts";

const ENV_VAR = "MAKEFUN_ENV_URL";
const TRY_TIMEOUT_MS = 30_000;
const FIRST_PAUSE_MS = 250;
const LONGEST_PAUSE_MS = 2_000;

// The environment URL from the process environment, with any trailing
// slashes trimmed so endpoint paths can be appended cleanly.
function environmentBase(): string {
  const raw = process.env[ENV_VAR] ?? "";
  return raw.replace(/\/+$/, "");
}

function pause(ms: number): Promise<void> {
  return new Promise((done) => setTimeout(done, ms));
}

// Backoff ladder: 250, 500, 1000, 2000, then 2000 forever.
function longerPause(current: number): number {
  const doubled = current * 2;
  return doubled > LONGEST_PAUSE_MS ? LONGEST_PAUSE_MS : doubled;
}

// Tell the environment service which port this bot listens on. Keeps
// trying until the service accepts the announcement. A 200 means the
// port was recorded; a 409 means another registration got there first
// and this one is still fine. A 400 or 405 means the request itself is
// wrong, so there is no point retrying.
async function announce(base: string, port: number): Promise<boolean> {
  let wait = FIRST_PAUSE_MS;
  for (;;) {
    try {
      const answer = await fetch(`${base}/register`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ port }),
        signal: AbortSignal.timeout(TRY_TIMEOUT_MS),
      });
      if (answer.status === 200 || answer.status === 409) {
        console.log(`announced port ${port} to the environment (HTTP ${answer.status})`);
        return true;
      }
      if (answer.status === 400 || answer.status === 405) {
        console.error(`environment refused the announcement with HTTP ${answer.status}; stopping`);
        return false;
      }
      console.error(`announcement got HTTP ${answer.status}; retrying in ${wait} ms`);
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`announcement failed (${detail}); retrying in ${wait} ms`);
    }
    await pause(wait);
    wait = longerPause(wait);
  }
}

// Ask the environment service, over and over, whether the trial is
// over. Any hiccup — a failed request, a non-OK answer, a body that
// does not say done — just means "not yet", so poll again.
async function waitUntilDone(base: string): Promise<void> {
  let wait = FIRST_PAUSE_MS;
  for (;;) {
    try {
      const answer = await fetch(`${base}/done`, {
        signal: AbortSignal.timeout(TRY_TIMEOUT_MS),
      });
      if (answer.ok) {
        const payload = (await answer.json()) as { done?: unknown };
        if (payload.done === true) {
          console.log("environment reports the trial is done; winding down");
          return;
        }
      } else {
        console.error(`done probe got HTTP ${answer.status}; polling again in ${wait} ms`);
      }
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      console.error(`done probe failed (${detail}); polling again in ${wait} ms`);
    }
    await pause(wait);
    wait = longerPause(wait);
  }
}

async function run(): Promise<number> {
  const base = environmentBase();
  if (base === "") {
    console.error(`${ENV_VAR} is not set in the environment; cannot register`);
    return 1;
  }

  const server = createApp();
  const port = await new Promise<number | null>((resolve) => {
    server.once("error", (err: Error) => {
      console.error(`could not bind the forge server: ${err.message}`);
      resolve(null);
    });
    server.listen(0, () => {
      const bound = server.address();
      if (bound === null || typeof bound === "string") {
        console.error("forge server did not bind to a TCP port");
        server.close();
        resolve(null);
        return;
      }
      resolve(bound.port);
    });
  });
  if (port === null) return 1;
  console.log(`forge server listening on port ${port}`);

  const accepted = await announce(base, port);
  if (!accepted) return 1;

  await waitUntilDone(base);

  await new Promise<void>((done) => {
    server.close(() => done());
  });
  console.log("forge server stopped; exiting");
  return 0;
}

run().then(
  (code) => process.exit(code),
  (err: unknown) => {
    const detail = err instanceof Error ? err.message : String(err);
    console.error(`unexpected failure in the bot lifecycle: ${detail}`);
    process.exit(1);
  },
);
