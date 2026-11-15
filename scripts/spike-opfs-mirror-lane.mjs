// Spike (OFFLINE, Wasm-free): the mirror lane's data-safety invariants, driven against
// the SHIPPED createMirrorLane / createMirrorLaneClient over an in-memory OPFS.
//
// WHY THIS EXISTS. PR #3 added an optional write-ahead journal lane in its own worker
// so the FS worker no longer pays a per-file open/truncate/write/flush/close. Review of
// that PR found data-loss bugs that nothing in CI could see: the old lane kept only the
// LAST op per path (so "rm -rf /a; write /a/b" lost the descendant), an async onmessage
// is not a queue (so a write could interleave a flush's truncate and vanish), replay
// trusted stale records enough to roll back newer direct-path writes, a torn journal
// tail could refuse to boot, a lane-wide failure aborted materialisation, and the client
// could leave promises pending forever on a worker fault. Every one of those is an
// invariant here, because they are all invisible in a browser until a reload loses work.
//
// HOW IT IS GATED. scripts/lib/fake-opfs.mjs is the same in-memory OPFS the two older
// OPFS spikes drive opfs-persistence.js against, extended with what the lane needs:
// offset-honouring sync access handles, getFile() with lastModified (replay's stale
// guard), an injectable write failure, access-handle open/close observation, and
// closeAllHandles() to simulate a killed tab. The client half is driven with a fake
// Worker object, since no browser exists here.
//
// The integration half (where PR #3's manifest/durability bugs lived) drives the SHIPPED
// createOpfsPersistence too: the manifest flush barrier, failLane containment + ordered
// requeue (including the "d" -> "r" re-created-node fix and the residue filter), the
// lane write/remove/flush watchdogs for a hung worker, and init()'s staged index read
// under the vv-vfs-manifest lock. One case runs a REAL createMirrorLane behind the shipped
// client through a fake worker; the failure cases swap in a controllable lane client.
//
// No kernel and no Wasm are involved: this imports plain ESM modules and the fake.
//
//   run:  node scripts/spike-opfs-mirror-lane.mjs

import {
  createMirrorLane,
  discardJournalIfUnlocked,
  JOURNAL_LOCK,
} from "../packages/kernel-host/mirror-lane.js";
import { createMirrorLaneClient } from "../packages/kernel-host/mirror-lane-client.js";
import { createOpfsPersistence } from "../packages/kernel-host/opfs-persistence.js";
import { fakeOpfs, fakeLocks, fakeVfs, bytes, text } from "./lib/fake-opfs.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};
// Settle a promise on either side without ever leaving it unhandled.
const rejects = async (promise, pattern) => {
  try {
    await promise;
    return false;
  } catch (error) {
    const line = String((error && error.message) || error);
    return pattern ? pattern.test(line) : true;
  }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const ROOT = "vv-vfs";
const decoder = new TextDecoder();

// One origin: the in-memory OPFS, and (when asked) one Web Locks engine. Every group
// gets a fresh pair, so a journal or a body left by another group cannot leak in.
function origin(options = {}) {
  const storage = fakeOpfs(options);
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage },
  });
  return storage;
}
function originWithLocks(options = {}) {
  const storage = fakeOpfs(options);
  const locks = fakeLocks();
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: { storage, locks },
  });
  return { storage, locks };
}

const bodyRaw = (storage, path) =>
  storage.readRaw(ROOT, "files", ...path.split("/").filter(Boolean));
const bodyText = (storage, path) => {
  const raw = bodyRaw(storage, path);
  return raw === undefined ? null : text(raw);
};
const journalBytes = (storage) => storage.readRaw(ROOT, "journal.wal");
const journalSize = (storage) => {
  const raw = journalBytes(storage);
  return raw ? raw.length : 0;
};
// Write an index into the fake OPFS. The default target is the live index; the
// readManifest-robustness group also plants the staged manifest.json.new copy.
const writeManifest = (storage, paths, ...target) => {
  const entries = paths.map((path) => [path, { k: "file", m: 0o644 }]);
  storage.writeRaw(bytes(JSON.stringify(entries)), ...(target.length ? target : [ROOT, "manifest.json"]));
};
const manifestEntries = (storage) => {
  const raw = storage.readRaw(ROOT, "manifest.json");
  if (!raw) return null;
  try {
    return JSON.parse(text(raw));
  } catch {
    return null;
  }
};
const manifestHas = (storage, path) => (manifestEntries(storage) || []).some((entry) => entry[0] === path);
// A killed tab: the browser releases the journal handle, so another lane can open it.
const crash = (storage) => storage.closeAllHandles();

// Parse the WAL's record headers and offsets out of the fake OPFS. The framing
// (u32le header length, JSON header, body) is the lane's contract with its own replay,
// so the stale-guard tests pin it rather than guessing at record timestamps.
function journalRecords(storage) {
  const raw = journalBytes(storage);
  if (!raw || !raw.length) return [];
  const records = [];
  let at = 0;
  while (at + 4 <= raw.length) {
    const headerLength = new DataView(raw.buffer, raw.byteOffset + at, 4).getUint32(0, true);
    if (!headerLength || at + 4 + headerLength > raw.length) break;
    let header;
    try {
      header = JSON.parse(decoder.decode(raw.subarray(at + 4, at + 4 + headerLength)));
    } catch {
      break;
    }
    const bodyStart = at + 4 + headerLength;
    const bodyLength = typeof header.s === "number" ? header.s : -1;
    if (bodyLength < 0 || bodyStart + bodyLength > raw.length) break;
    records.push({ header, at, bodyStart, bodyLength });
    at = bodyStart + bodyLength;
  }
  return records;
}

// A group that throws reports as a failed assertion instead of aborting the rest of
// the spike: one broken invariant should not hide the other nine.
async function group(title, fn) {
  console.log("\n== " + title + " ==");
  try {
    await fn();
  } catch (error) {
    ok(false, "group threw: " + ((error && error.stack) || error));
  }
}

// A Worker stand-in for the client half: records every post, lets a test emit
// messages/errors exactly as the real worker would.
function fakeWorker() {
  const worker = {
    posted: [],
    terminated: 0,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    postMessage(message, transfer) {
      worker.posted.push({ message, transfer });
    },
    terminate() {
      worker.terminated += 1;
    },
    emit(data) {
      if (worker.onmessage) worker.onmessage({ data });
    },
    fail(message) {
      if (worker.onerror) worker.onerror({ message });
    },
    last() {
      return worker.posted[worker.posted.length - 1];
    },
  };
  return worker;
}


// ---------------------------------------------------------------------------
// Integration-half helpers: the shipped createOpfsPersistence driven over fakeOpfs +
// fakeVfs, exactly as fs-worker.ts drives it, with either a real lane (the shipped
// createMirrorLane behind the shipped client, via the fake worker driver below) or a
// controllable lane client whose write/remove/flush the test can reject, error or hang.
// ---------------------------------------------------------------------------

// A lane client with the full contract the integration relies on, where each call can
// be swapped for a test's own (a rejecting/hanging flush, a hanging write, ...).
function fakeLaneClient(options = {}) {
  const lane = {
    ready: Promise.resolve({ replayed: 0, skipped: 0 }),
    dead: new Promise(() => {}),
    writes: [],
    removes: [],
    flushCalls: 0,
    terminated: 0,
    write(path, data) {
      lane.writes.push([path, data]);
      return options.write ? options.write(path, data, lane) : undefined;
    },
    remove(path) {
      lane.removes.push(path);
      return options.remove ? options.remove(path, lane) : undefined;
    },
    flush() {
      lane.flushCalls += 1;
      return options.flush ? options.flush(lane) : Promise.resolve({ flushed: lane.writes.length, errors: [] });
    },
    terminate() {
      lane.terminated += 1;
    },
  };
  return lane;
}

// The mirror-worker side of the shipped client protocol, backed by the REAL
// createMirrorLane: write/remove dispatch on one chain (as mirror-worker.js chains its
// handlers), flush replies by id, fire-and-forget failures become {type:"log"} lines and
// posted bytes are acked at 1 MiB.
function realLaneWorker(lane) {
  const worker = {
    posted: [],
    terminated: 0,
    onmessage: null,
    onerror: null,
    onmessageerror: null,
    chain: Promise.resolve(),
    unacked: 0,
    postMessage(message) {
      worker.posted.push(message);
      worker.chain = worker.chain.then(() => dispatch(message)).catch(() => {});
    },
    terminate() {
      worker.terminated += 1;
    },
    emit(data) {
      if (worker.onmessage) worker.onmessage({ data });
    },
  };
  const failure = (error) => String((error && error.message) || error);
  async function dispatch(message) {
    if (!message || worker.terminated) return; // a terminated worker processes nothing
    if (message.type === "write") {
      try {
        await lane.write(message.path, message.bytes);
      } catch (error) {
        worker.emit({ type: "log", line: failure(error) });
      }
      worker.unacked += message.bytes && message.bytes.length ? message.bytes.length : 0;
      if (worker.unacked >= 1024 * 1024) {
        const bytes = worker.unacked;
        worker.unacked = 0;
        worker.emit({ type: "ack", bytes });
      }
      return;
    }
    if (message.type === "remove") {
      try {
        await lane.remove(message.path);
      } catch (error) {
        worker.emit({ type: "log", line: failure(error) });
      }
      return;
    }
    if (message.type === "flush") {
      try {
        const result = await lane.flush();
        worker.emit({ id: message.id, ok: true, result });
      } catch (error) {
        worker.emit({ id: message.id, ok: false, error: failure(error) });
      }
    }
  }
  return worker;
}

// One boot-equivalent of createOpfsPersistence: a fresh origin, a fresh fake VFS and the
// given lane, with a small flush/watchdog timeout so a hung lane cannot slow the gate.
async function openPersistence({ lane, laneFlushTimeoutMs = 5000, storageOptions = {} } = {}) {
  const { storage, locks } = originWithLocks(storageOptions);
  const vfs = fakeVfs();
  const laneErrors = [];
  const persistence = await createOpfsPersistence({
    access: vfs,
    lane,
    laneFlushTimeoutMs,
    onLaneError: (line) => laneErrors.push(line),
  });
  return { storage, locks, vfs, persistence, laneErrors };
}

const originalNavigator = globalThis.navigator;
try {
  // ---------------------------------------------------------------------------
  await group("ordered materialisation", async () => {
    const storage = origin();
    const lane = await createMirrorLane();

    // The batch a "rm -rf /a then write /a/new" produces: a write under the ancestors,
    // the delete of the ancestor, then the write after it. Materialisation order must
    // match the journal order or the delete runs last and takes the new body with it.
    await lane.write("/a/old.txt", bytes("old"));
    await lane.remove("/a");
    await lane.write("/a/new.txt", bytes("new"));
    const res = await lane.flush();
    ok(res.flushed === 3 && res.errors.length === 0, "delete-ancestor + write-descendant materialises all three ops");
    ok(bodyRaw(storage, "/a/old.txt") === undefined, "…the deleted ancestor's old body is gone");
    ok(bodyText(storage, "/a/new.txt") === "new", "…and the descendant written after the delete survives");

    await lane.write("/t/x.txt", bytes("first"));
    await lane.write("/t/x.txt", bytes("second"));
    await lane.remove("/t/x.txt");
    const res2 = await lane.flush();
    ok(res2.flushed === 1 && bodyRaw(storage, "/t/x.txt") === undefined, "write-then-delete of one path materialises the delete");

    await lane.write("/u/x.txt", bytes("one"));
    await lane.remove("/u/x.txt");
    await lane.write("/u/x.txt", bytes("three"));
    await lane.flush();
    ok(bodyText(storage, "/u/x.txt") === "three", "write-delete-write materialises the last write, not the delete");

    // Rename-shaped: write the destination, then delete the source subtree. The
    // destination must not be removed by a delete that is applied out of order.
    await lane.write("/mv/src/file.txt", bytes("moved"));
    await lane.flush();
    await lane.write("/mv/dst/file.txt", bytes("moved"));
    await lane.remove("/mv/src");
    await lane.flush();
    ok(bodyText(storage, "/mv/dst/file.txt") === "moved", "a rename-shaped batch keeps the destination");
    ok(bodyRaw(storage, "/mv/src/file.txt") === undefined, "…and drops the source");
  });

  // ---------------------------------------------------------------------------
  await group("1000 un-awaited writes then one flush", async () => {
    const storage = origin();
    const lane = await createMirrorLane();
    const writes = [];
    for (let i = 0; i < 1000; i += 1) writes.push(lane.write("/flood/f-" + i + ".txt", bytes("value-" + i)));
    await lane.flush();
    const settled = await Promise.allSettled(writes);
    const rejected = settled.filter((s) => s.status === "rejected");
    ok(rejected.length === 0, "no un-awaited write rejects (none rejected)");
    let wrong = 0;
    for (let i = 0; i < 1000; i += 1) if (bodyText(storage, "/flood/f-" + i + ".txt") !== "value-" + i) wrong += 1;
    ok(wrong === 0, "every one of the 1000 bodies is on disk after a single flush");
    ok(bodyText(storage, "/flood/f-999.txt") === "value-999", "…including the last one, with exact bytes");
    ok(journalSize(storage) === 0, "…and the journal is checkpointed, so a crash cannot replay a materialised batch");
  });

  // ---------------------------------------------------------------------------
  await group("a write issued while a flush is in flight", async () => {
    let reached;
    let resume;
    let paused = false;
    const atPause = new Promise((r) => (reached = r));
    const held = new Promise((r) => (resume = r));
    const pause = () => {
      paused = true;
      reached();
      return held;
    };
    // Pause the in-flight materialisation half way through its first body write.
    const storage = origin({
      beforeFileHandle: (name) => (name === "slow.txt" && !paused ? pause() : undefined),
    });
    const lane = await createMirrorLane();
    await lane.write("/slow.txt", bytes("slow"));
    const flushing = lane.flush();
    await atPause;
    const late = lane.write("/late.txt", bytes("late"));
    resume();
    const [flushed, lateResult] = await Promise.all([flushing, late]);
    ok(flushed.flushed === 1, "the in-flight flush materialises its one entry");
    ok(bodyText(storage, "/slow.txt") === "slow", "…and that body is on disk");
    ok(lateResult === undefined, "a write issued during the flush is accepted, not rejected");
    ok(bodyText(storage, "/late.txt") === null, "…it stays pending while the flush runs (not smuggled into it)");
    await lane.flush();
    ok(bodyText(storage, "/late.txt") === "late", "…and the next flush materialises it, so it cannot vanish");
    ok(journalSize(storage) === 0, "…and the journal is checkpointed afterwards");
  });

  // ---------------------------------------------------------------------------
  await group("watermark flushes are serialized", async () => {
    let open = 0;
    let maxOpen = 0;
    const storage = origin({
      onAccessHandle: (name, phase) => {
        if (name === "journal.wal") return; // the lane keeps its one journal handle open
        if (phase === "open") {
          open += 1;
          if (open > maxOpen) maxOpen = open;
        } else {
          open -= 1;
        }
      },
    });
    const lane = await createMirrorLane();
    const body = new Uint8Array(16 * 1024);
    const writes = [];
    for (let i = 0; i < 600; i += 1) writes.push(lane.write("/wm/f-" + i + ".bin", body));
    const settled = await Promise.allSettled(writes);
    const rejected = settled.filter((s) => s.status === "rejected");
    ok(rejected.length === 0, "no write over the 8 MiB / 512-record watermark rejects");
    const final = await lane.flush();
    ok(final.errors.length === 0, "no materialisation error is carried over (no NoModificationAllowedError)");
    ok(maxOpen <= 1, "a watermark flush never overlaps another materialisation (max concurrent handles " + maxOpen + ")");
    ok(open === 0, "every body handle is closed");
    ok(bodyRaw(storage, "/wm/f-0.bin").length === body.length && bodyRaw(storage, "/wm/f-599.bin").length === body.length, "every body reached disk");
    ok(journalSize(storage) === 0, "…and the journal is checkpointed");
  });

  // ---------------------------------------------------------------------------
  await group("malformed journal tail", async () => {
    const variants = [
      ["short header", () => new Uint8Array([0x01, 0x00])],
      [
        "header length past EOF",
        () => {
          const tail = new Uint8Array(4);
          new DataView(tail.buffer).setUint32(0, 0x0fffffff, true);
          return tail;
        },
      ],
      ["header that is not JSON", () => new Uint8Array([0x04, 0, 0, 0, 0x6f, 0x6f, 0x70, 0x73])],
      [
        "body past EOF",
        () => {
          const head = bytes(JSON.stringify({ v: 1, t: Date.now(), op: "w", p: "/good/c.txt", s: 64 }));
          const record = new Uint8Array(4 + head.length);
          new DataView(record.buffer).setUint32(0, head.length, true);
          record.set(head, 4);
          return record;
        },
      ],
    ];
    for (const [label, makeTail] of variants) {
      const storage = origin();
      const writer = await createMirrorLane();
      await writer.write("/good/a.txt", bytes("a"));
      await writer.write("/good/b.txt", bytes("b"));
      writeManifest(storage, ["/good/a.txt", "/good/b.txt"]);
      // Then the crash's torn record: valid prefix, then bytes replay cannot parse.
      const cur = journalBytes(storage);
      const tail = makeTail();
      const torn = new Uint8Array(cur.length + tail.length);
      torn.set(cur);
      torn.set(tail, cur.length);
      storage.writeRaw(torn, ROOT, "journal.wal");
      crash(storage);
      const logs = [];
      const replayer = await createMirrorLane({ onLog: (line) => logs.push(line) });
      let result;
      try {
        result = await replayer.init();
      } catch (error) {
        ok(false, label + ": init rejected over a torn tail: " + ((error && error.message) || error));
        continue;
      }
      ok(result.replayed === 2, label + ": the valid prefix still replays");
      ok(result.droppedTail === true, label + ": the torn tail is reported (droppedTail)");
      ok(journalSize(storage) === 0, label + ": the bad tail is truncated after replay");
      ok(bodyText(storage, "/good/a.txt") === "a" && bodyText(storage, "/good/b.txt") === "b", label + ": both prefix bodies are rebuilt");
      ok(logs.some((line) => /malformed journal tail/.test(line)), label + ": one logged line says the tail was dropped");
      const again = await replayer.init();
      ok(again.replayed === 0 && journalSize(storage) === 0, label + ": a second init replays nothing and changes nothing");
    }
  });

  // ---------------------------------------------------------------------------
  await group("replay guards: writes", async () => {
    // A body newer than the record: a direct-path write landed after the crash. The
    // stale record must not roll it back.
    {
      let clock = 0;
      const storage = origin({ now: () => clock });
      const writer = await createMirrorLane();
      await writer.write("/g/a.txt", bytes("journal"));
      const record = journalRecords(storage)[0];
      crash(storage);
      writeManifest(storage, ["/g/a.txt"]);
      clock = record.header.t + 1000;
      storage.writeRaw(bytes("newer-direct"), ROOT, "files", "g", "a.txt");
      const lane = await createMirrorLane();
      const result = await lane.init();
      ok(result.replayed === 0 && result.skipped === 1, "a write record OLDER than its body is skipped");
      ok(bodyText(storage, "/g/a.txt") === "newer-direct", "…so a newer direct-path write is not rolled back");
      ok(journalSize(storage) === 0, "…and the journal is still checkpointed");
    }
    // Equal milliseconds: re-apply, because OPFS lastModified and record.t are both
    // millisecond-granular and a ">=" test would skip a live record (data loss).
    {
      let clock = 0;
      const storage = origin({ now: () => clock });
      const writer = await createMirrorLane();
      await writer.write("/g/b.txt", bytes("journal"));
      const record = journalRecords(storage)[0];
      crash(storage);
      writeManifest(storage, ["/g/b.txt"]);
      clock = record.header.t;
      storage.writeRaw(bytes("older-direct"), ROOT, "files", "g", "b.txt");
      const lane = await createMirrorLane();
      const result = await lane.init();
      ok(result.replayed === 1 && result.skipped === 0, "an equal-ms write record is RE-APPLIED (only a provably newer body wins)");
      ok(bodyText(storage, "/g/b.txt") === "journal", "…and the journal bytes win, which is idempotent");
      const again = await lane.init();
      ok(again.replayed === 0 && bodyText(storage, "/g/b.txt") === "journal", "replay is idempotent: the second init replays nothing and changes nothing");
    }
    // No manifest entry: restore could never show the path, and a newer boot may have
    // deleted it, so replaying it would invent a file the index does not know about.
    {
      const storage = origin();
      const writer = await createMirrorLane();
      await writer.write("/ghost/x.txt", bytes("ghost"));
      crash(storage);
      writeManifest(storage, ["/other.txt"]);
      const lane = await createMirrorLane();
      const result = await lane.init();
      ok(result.replayed === 0 && result.skipped === 1, "a write record the manifest does not name is not replayed");
      ok(bodyRaw(storage, "/ghost/x.txt") === undefined, "…so it is not resurrected as a file the index cannot show");
    }
    // No readable manifest at all: replay NOTHING rather than guess.
    {
      const storage = origin();
      const writer = await createMirrorLane();
      await writer.write("/ghost/y.txt", bytes("ghost"));
      crash(storage);
      const logs = [];
      const lane = await createMirrorLane({ onLog: (line) => logs.push(line) });
      const result = await lane.init();
      ok(result.replayed === 0, "with no readable manifest, replay resurrects nothing");
      ok(bodyRaw(storage, "/ghost/y.txt") === undefined, "…even though the journal holds bytes for it");
      ok(journalSize(storage) === 0, "…and the journal is discarded, not left for a later lane to replay");
      ok(logs.some((line) => /manifest\.json/.test(line)), "…with one logged line saying why");
    }
  });

  // ---------------------------------------------------------------------------
  await group("replay guards: deletes", async () => {
    // A body newer than the delete record: the direct path re-created the file.
    {
      let clock = 0;
      const storage = origin({ now: () => clock });
      const writer = await createMirrorLane();
      await writer.remove("/g/d.txt");
      const record = journalRecords(storage)[0];
      crash(storage);
      writeManifest(storage, []); // replay needs a readable index before it touches a record
      clock = record.header.t + 1000;
      storage.writeRaw(bytes("direct-created"), ROOT, "files", "g", "d.txt");
      const lane = await createMirrorLane();
      const result = await lane.init();
      ok(result.replayed === 0 && result.skipped === 1, "a delete record OLDER than a body is skipped");
      ok(bodyText(storage, "/g/d.txt") === "direct-created", "…so a file the direct path wrote after the crash survives");
    }
    // A body older than the record is the crashed lane's own stale body: delete it.
    {
      let clock = 0;
      const storage = origin({ now: () => clock });
      const writer = await createMirrorLane();
      await writer.remove("/g/e.txt");
      const record = journalRecords(storage)[0];
      crash(storage);
      writeManifest(storage, []);
      clock = record.header.t - 1000;
      storage.writeRaw(bytes("stale"), ROOT, "files", "g", "e.txt");
      const lane = await createMirrorLane();
      const result = await lane.init();
      ok(result.replayed === 1, "a delete record NEWER than a body is applied");
      ok(bodyRaw(storage, "/g/e.txt") === undefined, "…so the stale body is removed");
    }
    // Equal milliseconds: the delete still wins, for the same granularity reason.
    {
      let clock = 0;
      const storage = origin({ now: () => clock });
      const writer = await createMirrorLane();
      await writer.remove("/g/f.txt");
      const record = journalRecords(storage)[0];
      crash(storage);
      writeManifest(storage, []);
      clock = record.header.t;
      storage.writeRaw(bytes("same-ms"), ROOT, "files", "g", "f.txt");
      const lane = await createMirrorLane();
      const result = await lane.init();
      ok(result.replayed === 1, "an equal-ms delete record is re-applied");
      ok(bodyRaw(storage, "/g/f.txt") === undefined, "…so the delete is not lost to mtime granularity");
    }
  });

  // ---------------------------------------------------------------------------
  await group("one failing body write is contained", async () => {
    const quota = Object.assign(new Error("quota full"), { name: "QuotaExceededError" });
    const storage = origin({ failWrite: (name) => (name === "boom.txt" ? quota : null) });
    const logs = [];
    const lane = await createMirrorLane({ onLog: (line) => logs.push(line) });
    await lane.write("/fail/ok-a.txt", bytes("a"));
    await lane.write("/fail/boom.txt", bytes("boom"));
    await lane.write("/fail/ok-z.txt", bytes("z"));
    const res = await lane.flush();
    ok(res.flushed === 2, "one failing body write does not abort the rest of the batch");
    ok(res.errors.length === 1 && /boom\.txt/.test(res.errors[0]), "…the failure is reported in flush().errors");
    ok(logs.some((line) => /boom\.txt/.test(line)), "…and surfaced through onLog");
    ok(bodyText(storage, "/fail/ok-a.txt") === "a" && bodyText(storage, "/fail/ok-z.txt") === "z", "…the other bodies are materialised");
    // The handle is created before the write throws, so real OPFS leaves a zero-byte
    // file there; what must not exist is a partial body claiming to be the write.
    const boom = bodyRaw(storage, "/fail/boom.txt");
    ok(boom === undefined || boom.length === 0, "…and the failing body is empty, never half-written");
    await lane.write("/fail/after.txt", bytes("after"));
    const res2 = await lane.flush();
    ok(res2.flushed === 1 && bodyText(storage, "/fail/after.txt") === "after", "the lane is not wedged: the next write materialises");
    ok(journalSize(storage) === 0, "…and the journal is checkpointed");
  });

  // ---------------------------------------------------------------------------
  await group("discardJournalIfUnlocked", async () => {
    {
      const { storage, locks } = originWithLocks();
      storage.writeRaw(bytes("stale-journal"), ROOT, "journal.wal");
      const release = await locks.hold(JOURNAL_LOCK);
      ok((await discardJournalIfUnlocked()) === false, "a journal lock held by a live lane refuses the discard");
      ok(journalSize(storage) === 13, "…so the stale journal is left alone");
      release();
      await sleep(0); // let the fake lock release before probing it
      ok((await discardJournalIfUnlocked()) === true, "a free journal lock discards the stale journal");
      ok(journalBytes(storage) === undefined, "…and the file is actually gone");
      ok((await discardJournalIfUnlocked()) === false, "…a second discard reports false (nothing removed)");
    }
    {
      const storage = origin(); // no navigator.locks at all
      storage.writeRaw(bytes("no-locks"), ROOT, "journal.wal");
      ok((await discardJournalIfUnlocked()) === false, "without Web Locks the discard refuses (the caller decides)");
      ok(journalBytes(storage) !== undefined, "…and leaves the journal alone");
    }
  });

  // ---------------------------------------------------------------------------
  await group("client: log forwarding and byte backpressure", async () => {
    const worker = fakeWorker();
    const logs = [];
    const client = createMirrorLaneClient(worker, {
      onLog: (line) => logs.push(line),
      highWaterBytes: 16,
    });
    worker.emit({ type: "lane-ready", ok: true, replayed: 3, skipped: 1 });
    const ready = await client.ready;
    ok(ready.replayed === 3 && ready.skipped === 1, "ready resolves with the worker's replay counts");
    worker.emit({ type: "log", line: "  [opfs] mirror lane write /x: quota" });
    ok(logs.length === 1 && /quota/.test(logs[0]), "a worker {type:log} line reaches onLog (never silently dropped)");

    const throttled = client.write("/bp.txt", new Uint8Array(20));
    ok(throttled && typeof throttled.then === "function", "a write past the byte high-water mark returns a throttle promise");
    const posted = worker.last();
    ok(posted.message.type === "write" && posted.message.path === "/bp.txt", "…and posts {type:write, path, bytes}");
    ok(posted.transfer === undefined, "…with no transfer list, so the caller's bytes are copied, not detached");
    worker.emit({ type: "ack", bytes: 20 });
    await throttled;
    ok(true, "…and the next ack resolves the throttle promise");

    const flushing = client.flush();
    const flushMessage = worker.last().message;
    ok(flushMessage.type === "flush" && typeof flushMessage.id === "number", "flush posts an id-keyed request");
    worker.emit({ id: flushMessage.id, ok: true, result: { flushed: 2, errors: [] } });
    const flushed = await flushing;
    ok(flushed.flushed === 2, "…and resolves with the worker's result");
    const failing = client.flush();
    const failedFlush = rejects(failing, /checkpoint failed/);
    worker.emit({ id: worker.last().message.id, ok: false, error: "checkpoint failed" });
    ok(await failedFlush, "a failed flush rejects with the worker's error");
  });

  // ---------------------------------------------------------------------------
  await group("client: worker death, pending flushes, terminate", async () => {
    {
      const worker = fakeWorker();
      const client = createMirrorLaneClient(worker);
      worker.emit({ type: "lane-ready", ok: true, replayed: 0 });
      await client.ready;
      const pendingFlush = client.flush();
      worker.fail("worker blew up");
      const flushRejects = rejects(pendingFlush, /blew up/);
      const dead = await client.dead;
      ok(dead instanceof Error && /blew up/.test(dead.message), "a worker error settles dead with the reason");
      ok(await flushRejects, "…and rejects the flush that was in flight");
      client.terminate();
      client.terminate();
      ok(worker.terminated === 1, "terminate is idempotent (the worker is terminated once)");
      ok(client.write("/after.txt", new Uint8Array(2)) === undefined, "writes after death are dropped, so the caller re-queues them");
      ok(await rejects(client.flush()), "flush after death rejects instead of hanging");
    }
    {
      const worker = fakeWorker();
      const client = createMirrorLaneClient(worker);
      const readyRejects = rejects(client.ready, /failed to load mirror worker/);
      worker.fail("failed to load mirror worker");
      ok(await readyRejects, "a worker error before ready rejects ready");
      const dead = await client.dead;
      ok(dead instanceof Error, "…and settles dead, so nothing waits forever");
      ok(await rejects(client.flush(), /failed to load/), "…so a later flush rejects rather than posting into a dead worker");
    }
    {
      const worker = fakeWorker();
      const client = createMirrorLaneClient(worker);
      const readyRejects = rejects(client.ready, /Web Locks unavailable/);
      const deadSettles = client.dead;
      worker.emit({ type: "lane-ready", ok: false, reason: "Web Locks unavailable" });
      ok(await readyRejects, "lane-ready ok:false rejects ready with the worker's reason");
      const dead = await deadSettles;
      ok(dead instanceof Error && /Web Locks unavailable/.test(dead.message), "…and marks the lane dead (the worker closes itself)");
    }
    {
      const worker = fakeWorker();
      const client = createMirrorLaneClient(worker, { highWaterBytes: 1 });
      worker.emit({ type: "lane-ready", ok: true, replayed: 0 });
      await client.ready;
      const throttled = client.write("/queued.txt", new Uint8Array(4));
      const inFlight = client.flush();
      const inFlightRejects = rejects(inFlight, /terminated/);
      client.terminate();
      ok(worker.terminated === 1, "terminate before the ack terminates the worker");
      await throttled;
      ok(true, "…and resolves the byte-backpressure waiter instead of leaving it pending");
      ok(await inFlightRejects, "…and rejects the in-flight flush");
    }
    {
      const worker = fakeWorker();
      const client = createMirrorLaneClient(worker);
      client.terminate();
      ok(await rejects(client.ready, /terminated/), "terminate before boot rejects ready instead of leaving it pending");
    }
    {
      const worker = fakeWorker();
      const client = createMirrorLaneClient(worker);
      worker.emit({ type: "lane-ready", ok: true, replayed: 0 });
      await client.ready;
      const flushing = client.flush();
      const flushRejects = rejects(flushing, /deserialised/);
      worker.onmessageerror({});
      const dead = await client.dead;
      ok(/deserialised/.test(dead.message), "a message that cannot be deserialised is a worker fault, not a silent hang");
      ok(await flushRejects, "…and rejects the flush in flight");
    }
  });

  // ---------------------------------------------------------------------------
  await group("integration: the manifest is a lane-flush barrier", async () => {
    const events = [];
    let resumeBody;
    let paused = false;
    let reached;
    const atPause = new Promise((resolve) => (reached = resolve));
    const bodyHeld = new Promise((resolve) => (resumeBody = resolve));
    const { storage, locks } = originWithLocks({
      beforeFileHandle: (name) => {
        if (name === "manifest.json" || name === "manifest.json.new") events.push(["manifest", name]);
        if (name === "p.txt" && !paused) {
          paused = true;
          events.push(["body", name]);
          reached();
          return bodyHeld;
        }
        return undefined;
      },
    });
    const vfs = fakeVfs();
    const lane = await createMirrorLane();
    const worker = realLaneWorker(lane); // the shipped client + the real lane, end to end
    const laneLogs = [];
    const client = createMirrorLaneClient(worker, { onLog: (line) => laneLogs.push(line) });
    const initResult = await lane.init();
    worker.emit({ type: "lane-ready", ok: true, ...initResult });
    const laneErrors = [];
    const persistence = await createOpfsPersistence({
      access: vfs,
      lane: client,
      onLaneError: (line) => laneErrors.push(line),
      laneFlushTimeoutMs: 5000,
    });
    vfs.writeFile("/p.txt", bytes("hello"));
    persistence.onWrite("/p.txt");
    await atPause; // the real lane is paused inside the body write of its flush
    ok(worker.posted.some((message) => message.type === "flush"), "the drain asked the lane to flush before any index work");
    await sleep(20); // a window in which a non-barried index write would land
    ok(!events.some((event) => event[0] === "manifest"), "no manifest read/write happens while the lane flush is outstanding");
    ok(bodyText(storage, "/p.txt") === null, "…and the body it would name is not on disk yet");
    resumeBody();
    await persistence.flush();
    ok(bodyText(storage, "/p.txt") === "hello", "the body lands when the flush resolves");
    ok(manifestHas(storage, "/p.txt"), "the index names the path only after that successful flush");
    const bodyAt = events.findIndex((event) => event[0] === "body");
    const manifestAt = events.findIndex((event) => event[0] === "manifest");
    ok(bodyAt >= 0 && manifestAt > bodyAt, "…and it is written after the body (barrier order), not before");
    ok(laneErrors.length === 0 && laneLogs.length === 0, "a healthy lane reports no error and no log line");
  });

  // ---------------------------------------------------------------------------
  await group("integration: a failed lane flush is contained and re-queued", async () => {
    // (a) flush() rejects: the WHOLE lane batch goes back to the direct path.
    {
      const lane = fakeLaneClient({ flush: () => Promise.reject(new Error("lane broke")) });
      const { storage, vfs, persistence, laneErrors } = await openPersistence({ lane });
      vfs.writeFile("/a/new.txt", bytes("survive"));
      persistence.onDelete("/a"); // delete an ancestor first ...
      persistence.onWrite("/a/new.txt"); // ... then write under it in the same batch
      await persistence.flush(); // must resolve: a lane failure is not a page-hide failure
      ok(lane.terminated === 1, "a rejecting flush terminates the lane exactly once");
      ok(laneErrors.length === 1 && /mirror lane failed \(lane broke\)/.test(laneErrors[0]), "one onLaneError line names the failure");
      ok(bodyText(storage, "/a/new.txt") === "survive", "the batch is re-persisted through the direct path, in order");
      ok(manifestHas(storage, "/a/new.txt"), "…and the index names the re-persisted descendant");
      ok(!manifestHas(storage, "/a"), "…and does not resurrect the deleted ancestor entry");
      const writesBefore = lane.writes.length;
      vfs.writeFile("/after.txt", bytes("after"));
      persistence.onWrite("/after.txt");
      await persistence.flush();
      ok(lane.writes.length === writesBefore, "the lane stays disabled: later writes never reach it");
      ok(bodyText(storage, "/after.txt") === "after" && manifestHas(storage, "/after.txt"), "…and are persisted directly");
    }
    // (b) flush() RESOLVES with per-entry errors: the journal is checkpointed, so those
    // bodies are NOT on disk — the whole batch is a failure, not a per-entry hiccup.
    {
      const lane = fakeLaneClient({
        flush: () => Promise.resolve({ flushed: 1, errors: ["  [opfs] mirror lane write /boom.txt: quota"] }),
      });
      const { storage, vfs, persistence, laneErrors } = await openPersistence({ lane });
      vfs.writeFile("/ok.txt", bytes("ok"));
      vfs.writeFile("/boom.txt", bytes("boom"));
      persistence.onWrite("/ok.txt");
      persistence.onWrite("/boom.txt");
      await persistence.flush();
      ok(lane.terminated === 1, "a flush resolving with errors still fails the lane");
      ok(laneErrors.some((line) => /quota/.test(line) && /writing directly/.test(line)), "the per-entry error becomes the failure reason");
      ok(bodyText(storage, "/ok.txt") === "ok" && bodyText(storage, "/boom.txt") === "boom", "every path in the batch is re-persisted directly");
      ok(manifestHas(storage, "/ok.txt") && manifestHas(storage, "/boom.txt"), "…and the index names both");
    }
    // (c) a rejected lane.write is a lane failure, not a swallowed per-entry error.
    {
      let rejectOnce = true;
      const lane = fakeLaneClient({
        write: () => {
          if (!rejectOnce) return undefined;
          rejectOnce = false;
          return Promise.reject(new Error("journal short write"));
        },
      });
      const { storage, vfs, persistence, laneErrors } = await openPersistence({ lane });
      vfs.writeFile("/w1.txt", bytes("one"));
      vfs.writeFile("/w2.txt", bytes("two"));
      persistence.onWrite("/w1.txt");
      persistence.onWrite("/w2.txt");
      await persistence.flush();
      ok(lane.terminated === 1, "a rejected lane.write disables the lane");
      ok(laneErrors.length === 1 && /journal short write/.test(laneErrors[0]), "…and is reported once");
      ok(bodyText(storage, "/w1.txt") === "one" && bodyText(storage, "/w2.txt") === "two", "both the failed and the later path persist directly");
      ok(manifestHas(storage, "/w1.txt") && manifestHas(storage, "/w2.txt"), "…and the index names both");
    }
  });

  // ---------------------------------------------------------------------------
  await group("integration: a hung lane flush is failed by the watchdog", async () => {
    const lane = fakeLaneClient({ flush: () => new Promise(() => {}) }); // never settles
    const { storage, vfs, persistence, laneErrors } = await openPersistence({ lane, laneFlushTimeoutMs: 50 });
    vfs.writeFile("/hang.txt", bytes("hang"));
    persistence.onWrite("/hang.txt");
    const started = Date.now();
    await persistence.flush(); // page-hide: must settle, not spin in settleDrain()
    const elapsed = Date.now() - started;
    ok(elapsed < 1000, "page-hide flush returns instead of spinning forever (" + elapsed + "ms)");
    ok(lane.terminated === 1, "the hung lane is terminated exactly once");
    ok(laneErrors.length === 1 && /lane flush did not answer in 50ms/.test(laneErrors[0]), "one onLaneError line names the flush timeout");
    ok(bodyText(storage, "/hang.txt") === "hang", "the pending write reaches the direct path");
    ok(manifestHas(storage, "/hang.txt"), "…and the index names it");
  });

  // ---------------------------------------------------------------------------
  await group("integration: a hung lane write/remove is failed by the watchdog", async () => {
    // (a) lane.write() never settles: it is the client's byte-backpressure promise, so a
    // hung worker can block drain() BEFORE any flush — the write await needs its own
    // watchdog, not just flushLane().
    {
      const lane = fakeLaneClient({ write: () => new Promise(() => {}) });
      const { storage, vfs, persistence, laneErrors } = await openPersistence({ lane, laneFlushTimeoutMs: 50 });
      vfs.writeFile("/stuck.txt", bytes("stuck"));
      persistence.onWrite("/stuck.txt");
      const started = Date.now();
      await persistence.flush();
      const elapsed = Date.now() - started;
      ok(elapsed < 1000, "page-hide flush settles even when lane.write() never answers (" + elapsed + "ms)");
      ok(lane.terminated === 1, "a hung write fails the lane and terminates it once");
      ok(laneErrors.length === 1 && /lane write did not answer in 50ms/.test(laneErrors[0]), "one onLaneError line names the write timeout");
      ok(bodyText(storage, "/stuck.txt") === "stuck", "the hung write's path is re-queued and re-persisted directly");
      ok(manifestHas(storage, "/stuck.txt"), "…and the index names it only then");
    }
    // (b) lane.remove() never settles: same containment for the delete op.
    {
      const lane = fakeLaneClient({ remove: () => new Promise(() => {}) });
      const { storage, vfs, persistence, laneErrors } = await openPersistence({ lane, laneFlushTimeoutMs: 50 });
      // A body this tab already mirrors, then a delete of it: the lane remove is what hangs.
      storage.writeRaw(bytes("bye"), ROOT, "files", "gone.txt");
      vfs.entries.delete("/gone.txt");
      persistence.onDelete("/gone.txt");
      const started = Date.now();
      await persistence.flush();
      const elapsed = Date.now() - started;
      ok(elapsed < 1000, "page-hide flush settles even when lane.remove() never answers (" + elapsed + "ms)");
      ok(lane.terminated === 1, "a hung remove fails the lane and terminates it once");
      ok(laneErrors.length === 1 && /lane remove did not answer in 50ms/.test(laneErrors[0]), "one onLaneError line names the remove timeout");
      ok(bodyRaw(storage, "/gone.txt") === undefined, "the requeued delete runs on the direct path and removes the body");
      ok(!manifestHas(storage, "/gone.txt"), "…and the index does not name the deleted path");
    }
  });

  // ---------------------------------------------------------------------------
  await group("integration: a failed delete requeue re-mirrors the re-created node", async () => {
    // (a) the ancestor is re-created as a DIRECTORY (with a child) before the lane fails:
    // a plain "d" requeue would leave it out of OPFS; the "d" -> "r" requeue re-reads the
    // current VFS truth and re-creates it.
    {
      const lane = fakeLaneClient({ flush: () => Promise.reject(new Error("lane broke")) });
      const { storage, vfs, persistence, laneErrors } = await openPersistence({ lane });
      vfs.mkdirp("/d");
      persistence.onDelete("/d");
      vfs.mkdirp("/d"); // re-created in the VFS, same batch
      persistence.onWrite("/d");
      vfs.writeFile("/d/x.txt", bytes("x"));
      persistence.onWrite("/d/x.txt");
      await persistence.flush();
      ok(lane.terminated === 1 && laneErrors.length === 1, "the lane failure is contained on a re-created directory batch");
      ok(storage.hasDirectoryRaw(ROOT, "files", "d"), "the direct path re-creates the directory after the failed delete");
      ok(bodyText(storage, "/d/x.txt") === "x", "…and mirrors the new descendant");
      ok(manifestHas(storage, "/d") && manifestHas(storage, "/d/x.txt"), "…and the index names both");
    }
    // (b) the deleted ancestor has only a re-created descendant FILE under it (no VFS
    // entry for the ancestor itself): the "r" requeue must remove then re-read, and the
    // descendant must not be lost to the delete that was already applied.
    {
      const lane = fakeLaneClient({ flush: () => Promise.reject(new Error("lane broke")) });
      const { storage, vfs, persistence, laneErrors } = await openPersistence({ lane });
      vfs.writeFile("/a/new.txt", bytes("survive"));
      persistence.onDelete("/a");
      persistence.onWrite("/a/new.txt");
      await persistence.flush();
      ok(lane.terminated === 1 && laneErrors.length === 1, "the lane failure is contained on a delete-ancestor batch");
      ok(bodyText(storage, "/a/new.txt") === "survive", "the re-created descendant survives the requeued delete");
      ok(manifestHas(storage, "/a/new.txt"), "…and the index names it");
      ok(!manifestHas(storage, "/a"), "…without resurrecting the ancestor");
    }
  });

  // ---------------------------------------------------------------------------
  await group("integration: replay reads the index under the manifest lock", async () => {
    // A live index caught half-written (engines without move() truncate+write it) whose
    // staged copy is complete: init() must read the staged copy, not discard the journal.
    {
      const { storage, locks } = originWithLocks();
      const writer = await createMirrorLane();
      await writer.write("/r/a.txt", bytes("journal"));
      storage.closeAllHandles();
      storage.writeRaw(bytes("[{\"/r/a.txt\","), ROOT, "manifest.json"); // torn live index
      writeManifest(storage, ["/r/a.txt"], ROOT, "manifest.json.new"); // complete staged copy
      const lane = await createMirrorLane();
      const result = await lane.init();
      ok(result.replayed === 1, "init() replays through the staged manifest.json.new when the live index is half-written");
      ok(bodyText(storage, "/r/a.txt") === "journal", "…the journal body is rebuilt");
      ok(journalSize(storage) === 0, "…and the journal is checkpointed instead of discarded unread");
      crash(storage); // this lane's journal handle must go before another lane can open it
      // The manifest lock is a real lock, not a hint: a boot must WAIT for the tab that
      // is rewriting the index rather than read the half-written copy.
      const writer2 = await createMirrorLane();
      await writer2.write("/r/b.txt", bytes("journal2"));
      storage.closeAllHandles();
      storage.writeRaw(bytes("[{\"/r/b.txt\","), ROOT, "manifest.json");
      writeManifest(storage, ["/r/b.txt"], ROOT, "manifest.json.new");
      const release = await locks.hold("vv-vfs-manifest");
      const lane2 = await createMirrorLane();
      let settled = false;
      const initPromise = lane2.init().then((value) => {
        settled = true;
        return value;
      });
      await sleep(60);
      ok(!settled, "init() waits for the vv-vfs-manifest lock instead of reading the torn index");
      release();
      const second = await initPromise;
      ok(second.replayed === 1, "…then replays once the other tab releases the lock");
      ok(bodyText(storage, "/r/b.txt") === "journal2", "…rebuilding the journal body");
    }
  });

} finally {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
}

console.log(
  "\nRESULT: " +
    (failed
      ? "FAIL (" + failed + " assertion" + (failed === 1 ? "" : "s") + ")"
      : "PASS — the mirror lane keeps every recovery, ordering and containment invariant"),
);
process.exit(failed ? 1 : 0);
