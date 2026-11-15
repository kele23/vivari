// FS-worker side of the mirror lane: fire-and-forget writes, one awaited flush.
//
// Writes are NOT transferred: the bytes come from the VFS and stay live there, so a transfer
// would detach them. Structured clone copies, which is what we want.
//
// Two guarantees this file owes the caller, both learned from review of the first version:
//   * every promise it hands out settles. A worker fault or terminate() rejects in-flight
//     flushes, settles `dead`, and RESOLVES outstanding byte-backpressure waiters — the
//     integration re-queues those paths on the direct write path, so a rejection there would
//     surface a spurious lane error for work that is about to be persisted anyway. Nothing
//     may hang forever, including a ready promise whose worker was terminated before boot.
//   * a {type:"log"} line is never dropped: fire-and-forget writes have no reply channel, so
//     that message is the only way a per-entry failure becomes visible.

export function createMirrorLaneClient(worker, { onLog, highWaterBytes = 8 * 1024 * 1024 } = {}) {
  const log = (line) => {
    if (typeof onLog !== "function") return;
    try {
      onLog(line);
    } catch {
      /* a logger must never break the lane */
    }
  };

  let nextId = 1;
  const pending = new Map(); // flush request id -> { resolve, reject }
  let unackedBytes = 0; // posted write bytes the worker has not acknowledged yet
  let ackWaiters = []; // resolved by the next {type:"ack"} (byte backpressure)
  let terminated = false;
  let deathReason = null;

  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });
  let readySettled = false;
  const settleReady = (fn, value) => {
    if (readySettled) return;
    readySettled = true;
    fn(value);
  };

  let settleDeath;
  const dead = new Promise((resolve) => {
    settleDeath = resolve;
  });
  let deathSettled = false;
  // Resolves (never rejects) with the reason: not every caller awaits it, and an unhandled
  // rejection here would take the FS worker down for a lane that is already gone.
  const die = (error) => {
    if (deathSettled) return;
    deathSettled = true;
    deathReason = error;
    settleDeath(error);
  };

  const rejectPendingFlushes = (error) => {
    for (const [, entry] of pending) entry.reject(error);
    pending.clear();
  };
  // Resolve, not reject: see the header. The caller re-queues the paths it posted.
  const releaseBackpressure = () => {
    const waiters = ackWaiters;
    ackWaiters = [];
    for (const resolve of waiters) resolve();
  };

  worker.onmessage = (event) => {
    const d = (event && event.data) || {};
    if (d.type === "lane-ready") {
      if (d.ok) {
        settleReady(resolveReady, {
          replayed: d.replayed | 0,
          skipped: d.skipped | 0,
          droppedTail: !!d.droppedTail,
        });
      } else {
        const error = new Error(d.reason || "mirror lane unavailable");
        settleReady(rejectReady, error);
        // The worker closes after reporting ok:false (it must not keep the journal or the
        // Web Lock), and a worker's self.close() fires no event on this side. Mark the lane
        // dead here so a later flush() rejects instead of posting into a closed worker and
        // staying pending forever.
        die(error);
      }
      return;
    }
    if (d.type === "log") {
      if (typeof d.line === "string") log(d.line);
      return;
    }
    if (d.type === "ack") {
      unackedBytes = Math.max(0, unackedBytes - (typeof d.bytes === "number" ? d.bytes : 0));
      releaseBackpressure();
      return;
    }
    const entry = d.id ? pending.get(d.id) : null;
    if (!entry) return;
    pending.delete(d.id);
    if (d.ok) entry.resolve(d.result);
    else entry.reject(new Error(d.error || "mirror lane op failed"));
  };

  const onWorkerFailure = (detail) => {
    const error = new Error(detail || "mirror worker error");
    // Before ready there is no lane to lose: reject ready. After ready the lane is dead for
    // this session and the caller falls back to the direct path; either way nothing may be
    // left pending.
    settleReady(rejectReady, error);
    die(error);
    rejectPendingFlushes(error);
    releaseBackpressure();
  };
  worker.onerror = (event) => {
    const detail =
      (event && (event.message || (event.error && event.error.message))) || null;
    onWorkerFailure(detail);
  };
  // The reply could not be deserialised: the worker faulted in a way onerror may not report.
  worker.onmessageerror = () => onWorkerFailure("mirror worker message could not be deserialised");

  // Post one fire-and-forget operation. Under the byte high-water mark this returns
  // undefined; over it, a promise settled by the next ack, so the FS drain throttles instead
  // of queueing an unbounded amount of body bytes inside the lane worker.
  function post(message, bytes) {
    if (terminated || deathReason) return undefined; // dropped; the caller re-queues its own paths
    worker.postMessage(message);
    if (bytes && bytes.length) unackedBytes += bytes.length;
    // The test is on the counter, not on this message's size: a remove() (or a tiny write)
    // posted while the window is already over the mark must throttle too, otherwise a drain
    // mixing bodies and deletes can keep queueing work in the lane worker anyway.
    if (unackedBytes <= highWaterBytes) return undefined;
    return new Promise((resolve) => {
      ackWaiters.push(resolve);
    });
  }

  return {
    ready,
    dead,
    write(path, bytes) {
      // The bytes are copied by structured clone on purpose; never pass a transfer list here.
      return post({ type: "write", path, bytes }, bytes);
    },
    remove(path) {
      return post({ type: "remove", path }, null);
    },
    flush() {
      // Reject with the death reason when there is one: the caller logs it, so "the worker
      // crashed" is more useful than a generic message.
      if (deathReason) return Promise.reject(deathReason);
      if (terminated) return Promise.reject(new Error("mirror lane terminated"));
      const id = nextId++;
      return new Promise((resolve, reject) => {
        // Register before posting: a reply can arrive as soon as the worker runs.
        pending.set(id, { resolve, reject });
        worker.postMessage({ type: "flush", id });
      });
    },
    terminate() {
      if (terminated) return; // idempotent
      terminated = true;
      try {
        worker.terminate();
      } catch {
        /* already dead */
      }
      const error = new Error("mirror lane terminated");
      settleReady(rejectReady, error); // a ready that never settled must not hang forever
      die(error); // no-op when a worker fault already settled it
      rejectPendingFlushes(error);
      releaseBackpressure();
    },
  };
}
