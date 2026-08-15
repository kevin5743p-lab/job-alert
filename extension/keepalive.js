// keepalive.js — keeps the service worker alive across a long apply run.
//
// An MV3 service worker is torn down after roughly 30 seconds with no
// extension-API activity. `await`ing does not count as activity, so a run that
// spends two minutes waiting on a page load, a model call, or a pacing gap is
// simply killed part-way through — no error, no rejected promise, no `catch`,
// no `finally`. The run just stops existing, which is exactly as confusing to
// debug as it sounds: the row stays `running` forever with an empty step log.
//
// Calling any extension API resets that timer. This is the same trick the scan
// path already uses (`keepAlive` in background.js); it lives here as its own
// module so the apply path can share it without importing from background.js,
// which imports router.js and would close a cycle.
//
// Refcounted, because the pump and a run inside it both want it held.

const PING_MS = 20000;          // comfortably inside the ~30s idle timeout

let timer = null;
let holders = 0;

function ping() {
  // Cheapest API call that counts as activity. Errors are irrelevant — the
  // call itself is the point, not the answer.
  chrome.runtime.getPlatformInfo().catch(() => {});
}

/** Hold the worker open. Returns a release function. */
export function hold() {
  holders++;
  if (!timer) {
    ping();                     // reset the clock immediately, not in 20s
    timer = setInterval(ping, PING_MS);
  }
  let released = false;
  return () => {
    if (released) return;       // a double-release must not free someone else's hold
    released = true;
    if (--holders <= 0) {
      holders = 0;
      clearInterval(timer);
      timer = null;
    }
  };
}

/** Run `fn` with the worker held open, releasing however it ends. */
export async function alive(fn) {
  const release = hold();
  try { return await fn(); }
  finally { release(); }
}

export const isHeld = () => holders > 0;
