// Worker entry for the OPFS mirror lane (see kernel-host/mirror-lane.js).
//
// This worker owns the tab's journal handle. The Web Lock vv-vfs-journal is what makes exactly
// one tab the lane writer, so two tabs cannot interleave appends into one WAL. A worker that
// cannot take the lock (or has no Web Locks at all) reports that and closes: the FS worker
// then uses the direct write path. It must never keep the lock or the journal handle after a
// failure, and it must never open an unlocked journal.
//
// Message handling is serialized on a promise chain. An async self.onmessage is NOT a queue:
// awaiting inside the handler pauses only that handler while the next message starts another
// one, so a write could append while a flush is materialising and checkpointing, and the
// record would be lost. The chain makes each message finish before the next starts; the lane
// serializes internally too, so this is the cheap outer guarantee (and it keeps the ack
// accounting below in message order).
import { createMirrorLane, JOURNAL_LOCK } from "../../../kernel-host/mirror-lane.js";

// Release the client's byte window in chunks rather than per message: one postMessage per
// write would double the message traffic for no benefit.
const ACK_BYTES = 1024 * 1024;

let lane = null;
let ackedBytes = 0;
const post = (message) => self.postMessage(message);
const reasonOf = (error) => String((error && error.message) || error);

// Queue the failure answer FIRST, then close: self.close() runs after this task, so the
// message is still delivered. Closing releases the journal handle and, by terminating the
// worker, the Web Lock — a failed lane must never hold the lock for the rest of the session.
function fail(reason) {
  post({ type: "lane-ready", ok: false, reason });
  self.close();
}

async function handle(event) {
  const d = (event && event.data) || {};
  try {
    if (d.type === "write") {
      if (!lane) return;
      try {
        await lane.write(d.path, d.bytes);
      } finally {
        // Count attempted bytes even when the write failed: the ack exists to release the
        // client's byte window, not to promise durability (the lane reports its own errors
        // through {type:"log"}). Not acking a failed write would wedge the backpressure
        // window forever.
        if (d.bytes && d.bytes.length) ackedBytes += d.bytes.length;
        if (ackedBytes >= ACK_BYTES) {
          post({ type: "ack", bytes: ackedBytes });
          ackedBytes = 0;
        }
      }
    } else if (d.type === "remove") {
      if (!lane) return;
      await lane.remove(d.path);
    } else if (d.type === "flush") {
      if (!lane) {
        post({ id: d.id, ok: false, error: "mirror lane is not ready" });
        return;
      }
      const result = await lane.flush();
      post({ id: d.id, ok: true, result });
    }
  } catch (error) {
    const reason = reasonOf(error);
    // A fire-and-forget write has no reply channel, so surface the failure the same way the
    // direct path's per-entry catch does; the drain keeps going either way.
    if (d.id) post({ id: d.id, ok: false, error: reason });
    else post({ type: "log", line: "  [opfs] mirror lane write failed: " + reason });
  }
}

let chain = Promise.resolve();
self.onmessage = (event) => {
  chain = chain.then(() => handle(event)).catch((error) => {
    // handle() contains its own failures, so this is the "must never happen" path: report it
    // and keep the chain usable rather than leaving it permanently rejected.
    post({ type: "log", line: "  [opfs] mirror lane message failed: " + reasonOf(error) });
  });
};

async function main() {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== "function") return fail("Web Locks unavailable");

  let settleGrant;
  const granted = new Promise((resolve) => {
    settleGrant = resolve;
  });
  let lockError = null;
  // Hold the lock for the worker's lifetime: the callback's promise never settles, so the
  // request stays granted. (Awaiting the lock directly would release it as soon as main()
  // continued past this point.)
  locks
    .request(JOURNAL_LOCK, { ifAvailable: true }, async (lock) => {
      settleGrant(!!lock);
      if (!lock) return;
      await new Promise(() => {});
    })
    .catch((error) => {
      lockError = reasonOf(error);
      settleGrant(false);
    });
  if (!(await granted))
    return fail(lockError ? "Web Locks request failed: " + lockError : "another tab owns the journal");

  lane = await createMirrorLane({ onLog: (line) => post({ type: "log", line }) });
  const result = await lane.init();
  post({ type: "lane-ready", ok: true, ...result });
}

main().catch((error) => fail(reasonOf(error)));
