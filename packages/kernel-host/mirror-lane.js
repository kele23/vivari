// Journal + batched materialisation for the OPFS mirror, meant to run in its own worker.
//
// Why: a per-file createSyncAccessHandle/truncate/write/flush/close costs ~4 ms on the
// thread that also serves syscalls, and that thread is the FS worker. Here the caller only
// appends one record to one open journal handle; the fsync is paid once per drain, and the
// per-path files are rewritten afterwards, off the caller's thread.
//
// Durability model (write-ahead): a record is durable once journal.flush() returns, and only
// then is the per-path body rewritten. A crash between the two leaves the record in the
// journal, and init() replays it (guarded against newer files) before the VFS restore reads
// anything, so replay is idempotent. The rebuilt bodies are NOT fsynced one by one; the
// checkpoint (truncate + fsync of the journal) follows the last body write. So a TAB crash is
// safe — the journal, or the OS page cache the body writes went to, still holds the bytes —
// but an OS/power loss between the body writes and the checkpoint can drop that batch. That
// is the deliberate trade against the direct path's per-file fsync, and it is the whole speed
// win. Do not "fix" it by fsyncing each body or by checkpointing before the bodies are
// written: both take the win away.
//
// Ordering: all four public methods are serialized on one promise chain. Appends arrive as
// postMessages, and an async self.onmessage is NOT a queue: awaiting inside a handler only
// pauses that handler while the next message starts another one, so a write could append
// while flush() is truncating and its record would be lost. The chain makes
// append -> materialise -> checkpoint atomic with respect to each other and makes the public
// flush() single-flight (a concurrent caller queues behind the running pass).
//
// The pending op log is a Map keyed by path, ordered by LAST occurrence (delete + set moves
// the path to the end) so materialisation order matches replay order. That is what stops
// `rm -rf /a` followed by a write to /a/b from also deleting the new descendant.
//
// Not handled here: the manifest (it stays in opfs-persistence.js, which still owns the
// multi-tab merge and the staged replace) and directory creation (drain does that directly).

const JOURNAL = "journal.wal";
const MANIFEST = "manifest.json";
const MANIFEST_STAGE = MANIFEST + ".new";
const MANIFEST_LOCK = "vv-vfs-manifest";
const RECORD_V = 1;
// vv-vfs-journal: the Web Lock a lane worker holds for its lifetime. A boot that does not
// use the lane takes it with ifAvailable to discard a stale journal (discardJournalIfUnlocked
// below), and a second tab's lane backs off to the direct write path.
export const JOURNAL_LOCK = "vv-vfs-journal";
// Bound the window where records live only in this worker's memory: a huge cache install
// must not hold hundreds of MB, and durability must not wait for a queue that never empties.
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_RECORDS = 512;

const enc = new TextEncoder();
const dec = new TextDecoder();

const reasonOf = (error) => String((error && error.message) || error);
const noop = () => {};

export async function createMirrorLane({ rootDir = "vv-vfs", filesDir = "files", onLog } = {}) {
  const log = (line) => {
    if (typeof onLog !== "function") return;
    try {
      onLog(line);
    } catch {
      /* a logger must never break the lane */
    }
  };

  const origin = await navigator.storage.getDirectory();
  const base = await origin.getDirectoryHandle(rootDir, { create: true });
  const filesBase = await base.getDirectoryHandle(filesDir, { create: true });
  const journal = await (await base.getFileHandle(JOURNAL, { create: true })).createSyncAccessHandle();

  let offset = 0;
  // Body bytes appended to the journal since the last checkpoint. Bounds both the journal's
  // un-materialised size and the memory held by the pending log.
  let pendingBytes = 0;
  // path -> { op: "w"|"d", bytes: Uint8Array|null, t: number }. Ordered by last occurrence.
  const pending = new Map();
  // Per-entry materialisation failures are contained here so the caller can fall back to the
  // direct write path. An INTERNAL watermark flush (maybeFlush) has no public caller to report
  // to, and it checkpoints the journal anyway, so its failures are carried forward and
  // returned by the next public flush() — see flushCore() and the public flush() below.
  let carryErrors = [];

  const parts = (path) => path.split("/").filter(Boolean);
  async function parentFor(path, create) {
    const ps = parts(path);
    const name = ps.pop();
    let handle = filesBase;
    for (const part of ps) handle = await handle.getDirectoryHandle(part, { create });
    return [handle, name];
  }

  // Rebuild one body from an already-durable journal record. No fsync: see the header.
  async function writeFile(path, bytes) {
    const [dir, name] = await parentFor(path, true);
    const file = await dir.getFileHandle(name, { create: true });
    const handle = await file.createSyncAccessHandle();
    try {
      handle.truncate(0);
      if (bytes && bytes.length) handle.write(bytes, { at: 0 });
    } finally {
      handle.close();
    }
  }
  // Deliberately create:false: deleting a path that is not there must not create its ancestor
  // directories as a side effect. The old create:true form left empty directories behind on
  // every delete of a never-written path.
  async function removePath(path) {
    try {
      const [dir, name] = await parentFor(path, false);
      await dir.removeEntry(name, { recursive: true });
    } catch {
      /* already gone / never written / no parent directory */
    }
  }

  // The mtime of the current OPFS body, or null when there is none. Used by replay's stale
  // guard: a body newer than a journal record means a direct-path write landed after the
  // crashed lane wrote its record, and replaying the record would roll it back.
  async function lastModifiedOf(path) {
    try {
      const [dir, name] = await parentFor(path, false);
      const file = await (await dir.getFileHandle(name, { create: false })).getFile();
      return typeof file.lastModified === "number" ? file.lastModified : null;
    } catch {
      return null;
    }
  }

  // Append one record. Returns the body bytes as owned by this lane (a view into the record
  // we just copied), so the pending log never retains or later observes the caller's buffer.
  function append(header, body) {
    const head = enc.encode(JSON.stringify(header));
    const bodyLength = body ? body.length : 0;
    const record = new Uint8Array(4 + head.length + bodyLength);
    new DataView(record.buffer).setUint32(0, head.length, true);
    record.set(head, 4);
    if (bodyLength) record.set(body, 4 + head.length);
    // A short write means the record is not entirely in the journal, so it must not be
    // treated as durable: throw instead of advancing the offset over a torn record. Keeping
    // the offset put lets the next append overwrite the partial bytes, and replay stops at
    // the first record that does not parse, so the damage is contained either way.
    const wrote = journal.write(record, { at: offset });
    if (wrote !== record.byteLength)
      throw new Error(`vv-vfs: journal short write (${wrote}/${record.byteLength} bytes)`);
    offset += record.byteLength;
    return record.subarray(4 + head.length);
  }

  // Ordered by LAST occurrence: delete + set moves the path to the end, so replay order and
  // materialisation order agree when one batch touches the same path twice.
  function remember(path, entry) {
    pending.delete(path);
    pending.set(path, entry);
  }

  // Write-ahead, then materialise in pending-log order, then checkpoint. The journal flush
  // MUST stay before the first body write (that is what makes a crash mid-materialisation
  // recoverable) and the truncate MUST stay after the last one (a crash there replays records
  // that are already applied, which is idempotent).
  async function flushCore() {
    if (!offset && !pending.size) return { flushed: 0, errors: [] };
    journal.flush();
    const errors = [];
    let flushed = 0;
    for (const [path, entry] of pending) {
      try {
        if (entry.op === "w") await writeFile(path, entry.bytes);
        else await removePath(path);
        flushed += 1;
      } catch (error) {
        // One bad body (quota, an OPFS hiccup) must not abort the remaining entries or leave
        // the lane permanently dirty. Report it and keep materialising.
        const what = entry.op === "w" ? "write" : "delete";
        const line = `  [opfs] mirror lane ${what} ${path}: ${reasonOf(error)}`;
        errors.push(line);
        carryErrors.push(line);
        log(line);
      }
    }
    pending.clear();
    pendingBytes = 0;
    journal.truncate(0);
    offset = 0;
    journal.flush();
    return { flushed, errors };
  }

  async function maybeFlush() {
    if (pendingBytes >= MAX_PENDING_BYTES || pending.size >= MAX_PENDING_RECORDS) await flushCore();
  }

  // One chain for all four public methods: see the header. A rejected call is absorbed from
  // the chain (the caller still sees it) so one bad record cannot poison every later call.
  let chain = Promise.resolve();
  function serialized(run) {
    const result = chain.then(run, run);
    chain = result.then(noop, noop);
    return result;
  }

  async function writeCore(path, bytes) {
    const body = !bytes ? null : bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
    const t = Date.now();
    const copied = append({ v: RECORD_V, t, op: "w", p: path, s: body ? body.length : 0 }, body);
    remember(path, { op: "w", bytes: copied, t });
    pendingBytes += copied.length;
    await maybeFlush();
  }

  async function removeCore(path) {
    const t = Date.now();
    append({ v: RECORD_V, t, op: "d", p: path, s: 0 }, null);
    remember(path, { op: "d", bytes: null, t });
    await maybeFlush();
  }

  // Read vv-vfs/manifest.json once. Replay uses it as the membership guard; a missing or
  // unparseable index means this boot cannot show anything, so resurrecting bodies would only
  // create files the index does not know about (and a newer boot may have deleted).
  //
  // Read it the way restore() does: under the manifest Web Lock, and falling back to the
  // staged `manifest.json.new` copy, because the live file is replaced by truncate+write on
  // engines without move(). Reading it unlocked can catch that half-written index, declare it
  // unreadable and then discard a journal that was perfectly replayable.
  async function readManifestOnce() {
    for (const name of [MANIFEST, MANIFEST_STAGE]) {
      try {
        const handle = await base.getFileHandle(name);
        const parsed = JSON.parse(await (await handle.getFile()).text());
        if (Array.isArray(parsed)) return new Map(parsed);
      } catch {
        /* try the staged copy, then the caller retries */
      }
    }
    return null;
  }
  async function readManifest() {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    for (let attempt = 0; attempt < 3; attempt++) {
      let entries = null;
      try {
        entries =
          locks && typeof locks.request === "function"
            ? await locks.request(MANIFEST_LOCK, readManifestOnce)
            : await readManifestOnce();
      } catch {
        entries = null; // no usable Web Locks: one unlocked read per attempt
      }
      if (entries) return entries;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    return null;
  }

  // Replay a journal left by a crashed tab. Runs before the caller restores the VFS, so a
  // record whose body never reached its file is not lost.
  //
  // Guarded twice, because the Web Lock only excludes other LANES — a different boot may have
  // used the direct write path after the crash:
  //   * a "w" record is replayed only when its path is listed in vv-vfs/manifest.json;
  //   * a record is replayed only when the OPFS body is not NEWER than the record.
  //
  // A malformed tail (torn record: short header, bad JSON, body past EOF) stops the parse,
  // truncates the tail and never rejects: a crash can truncate exactly there, and refusing to
  // boot over one lost record would turn it into a dead application.
  async function initCore() {
    const size = journal.getSize();
    if (!size) return { replayed: 0, skipped: 0 };

    const manifest = await readManifest();
    if (!manifest) {
      log("  [opfs] mirror lane: no readable vv-vfs/manifest.json, discarding the journal");
      journal.truncate(0);
      offset = 0;
      journal.flush();
      return { replayed: 0, skipped: 0 };
    }

    const raw = new Uint8Array(size);
    const read = journal.read(raw, { at: 0 });
    // Trust only what the read actually returned: on a torn file getSize() and the read can
    // disagree for a moment, and parsing past the returned bytes would read garbage.
    const end = typeof read === "number" ? Math.min(read, size) : size;
    // A short read is a torn/partially readable journal: the bytes past what we got cannot be
    // trusted, so the tail is dropped like a bad record rather than parsed as zeros.
    const shortRead = end < size;
    let at = 0;
    let replayed = 0;
    let skipped = 0;
    let droppedTail = false;

    while (at + 4 <= end) {
      const headerLength = new DataView(raw.buffer, raw.byteOffset + at, 4).getUint32(0, true);
      if (!headerLength || at + 4 + headerLength > end) {
        droppedTail = true;
        break;
      }
      let header;
      try {
        header = JSON.parse(dec.decode(raw.subarray(at + 4, at + 4 + headerLength)));
      } catch {
        droppedTail = true;
        break;
      }
      const bodyStart = at + 4 + headerLength;
      const bodyLength = header && typeof header.s === "number" && header.s >= 0 ? header.s : -1;
      if (!header || bodyLength < 0 || bodyStart + bodyLength > end) {
        droppedTail = true;
        break;
      }
      if (
        header.v !== RECORD_V ||
        typeof header.p !== "string" ||
        (header.op !== "w" && header.op !== "d")
      ) {
        // Same verdict as a torn record: not a record this build can trust.
        droppedTail = true;
        break;
      }
      at = bodyStart + bodyLength;
      // A record written by the first (pre-timestamp) version has no `t`; treat it as the
      // oldest possible time, so the strict ">" guard below re-applies it rather than
      // dropping it for being "newer" than a real body.
      const t = typeof header.t === "number" && Number.isFinite(header.t) ? header.t : 0;
      // Staleness is STRICTLY ">", and that is deliberate. OPFS `lastModified` and record.t
      // are both millisecond-granular: a record appended at T.95ms and a body materialised at
      // T.7ms both floor to T, so ">=" would skip a live record and lose a real write. With
      // ">", an already-materialised record (t == mtime) is re-applied, which is harmless:
      // the bytes are the same and the operation is idempotent. Only a provably newer file
      // wins. Do not "fix" this back to ">=".
      if (header.op === "w") {
        if (!manifest.has(header.p)) {
          skipped += 1;
          continue;
        }
        const mtime = await lastModifiedOf(header.p);
        if (mtime !== null && mtime > t) {
          skipped += 1;
          continue;
        }
        try {
          await writeFile(header.p, raw.subarray(bodyStart, bodyStart + bodyLength));
          replayed += 1;
        } catch (error) {
          // A body that cannot be rebuilt must not abort the rest of the replay (or boot).
          skipped += 1;
          log(`  [opfs] mirror lane: replay of ${header.p} failed: ${reasonOf(error)}`);
        }
      } else {
        const mtime = await lastModifiedOf(header.p);
        if (mtime !== null && mtime > t) {
          skipped += 1;
          continue;
        }
        await removePath(header.p); // idempotent: absent is fine
        replayed += 1;
      }
    }
    // 1-3 bytes that cannot even hold a header are a torn tail too.
    if (at < end || shortRead) droppedTail = true;
    if (droppedTail) {
      // Drop just the unusable tail first, so a crash during the rest of init cannot leave a
      // journal whose head is known-bad.
      log("  [opfs] mirror lane: dropped a malformed journal tail");
      journal.truncate(at);
      journal.flush();
    }
    // Everything replayable has been applied (or deliberately skipped), so the journal has
    // done its job. A second init() therefore sees an empty journal and is a no-op.
    journal.truncate(0);
    offset = 0;
    journal.flush();
    return droppedTail ? { replayed, skipped, droppedTail } : { replayed, skipped };
  }

  // The public flush is the point where the caller decides whether the lane is still usable:
  // it must see failures from an internal watermark flush too, because those records have
  // already been checkpointed away and can never be replayed. Returns flushed from this pass
  // plus every error not yet reported.
  function publicFlush() {
    return serialized(async () => {
      const result = await flushCore();
      if (!carryErrors.length) return result;
      const errors = carryErrors;
      carryErrors = [];
      return { flushed: result.flushed, errors };
    });
  }

  return {
    init: () => serialized(initCore),
    write: (path, bytes) => serialized(() => writeCore(path, bytes)),
    remove: (path) => serialized(() => removeCore(path)),
    flush: publicFlush,
  };
}

// A boot that does not use the lane (flag off, or the worker failed to start) must invalidate
// a journal left by a crashed tab: otherwise a later lane boot could replay it over a tree
// the direct path has since changed. The lock is what tells "crashed" from "live": if a lane
// worker still holds vv-vfs-journal, replaying is its job, so this must not touch the file.
//
// Returns true only when it actually removed a journal, which is what lets the caller log it
// without crying wolf on every first boot. False covers all three no-op cases: the lock is
// held by a live lane, Web Locks is unavailable, or there was no journal to remove.
export async function discardJournalIfUnlocked({ rootDir = "vv-vfs" } = {}) {
  const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
  if (!locks || typeof locks.request !== "function") return false;
  let removed = false;
  try {
    await locks.request(JOURNAL_LOCK, { ifAvailable: true }, async (lock) => {
      if (!lock) return; // a live lane owns the journal
      const origin = await navigator.storage.getDirectory();
      let base;
      try {
        base = await origin.getDirectoryHandle(rootDir, { create: false });
      } catch {
        return; // no vv-vfs directory: nothing a lane could replay
      }
      try {
        await base.removeEntry(JOURNAL, { recursive: false });
        removed = true;
      } catch {
        /* NotFoundError: no stale journal */
      }
    });
  } catch {
    return false; // no usable Web Locks/storage: the caller decides
  }
  return removed;
}
