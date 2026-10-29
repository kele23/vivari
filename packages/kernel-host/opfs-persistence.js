// OPFS write-behind persistence for the Rust/Wasm VFS (Phase 2 — persistence).
//
// The VFS lives entirely in the File System Worker's wasm linear memory, so a
// reload wipes it. This adapter mirrors the VFS to the Origin Private File
// System (OPFS) so a project + its node_modules survive F5.
//
// Why OPFS: it is a real per-origin filesystem with SYNCHRONOUS access handles
// **inside a Worker** (createSyncAccessHandle) — the same primitive SQLite-wasm
// uses — which matches our worker-based, Atomics-blocking VFS far better than
// IndexedDB's async-only API. It draws from the large per-origin storage quota
// (shared with Cache API), so hundreds of MB of node_modules is fine.
//
// Model — WRITE-BEHIND MIRROR (not a backing store):
//   * The Rust VFS stays the source of truth in RAM (reads never touch OPFS →
//     no latency regression).
//   * FsServer forwards every successful *mutation* here (onWrite/onDelete/
//     onRename). We can't await OPFS from the synchronous syscall path, so we
//     only enqueue a dirty path and drain it on an async loop. Durability is
//     therefore eventual (a few ms behind); flush() forces a drain (page hide).
//   * Project paths and the index drain ahead of package-manager cache paths, and
//     the manifest is rewritten while the queue is busy: a reload must never roll
//     the index back to the last moment the queue happened to be empty.
//   * On boot restore() replays a small manifest back into the VFS BEFORE the
//     worker serves any syscall.
//
// Layout under the origin's OPFS:
//   vv-vfs/
//     files/…            one real OPFS file per VFS file (bytes only)
//     manifest.json      [ [path, {k,m,t}], … ] — the index: kind, mode, and
//                        (for symlinks) target. Dirs/symlinks have no `files/`
//                        entry, so the manifest is what recreates them.
//
// `access` is a small vfs-bound facade injected by the File System Worker
// (read/walk/mkdirp/writeFile/symlink); this module never imports the wasm VFS
// directly, so it stays environment-agnostic and headless never loads it.

const ROOT_DIR = "vv-vfs";
const FILES_DIR = "files";
const MANIFEST = "manifest.json";

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function createOpfsPersistence({
  access,
  shouldPersist = () => true,
  isLowPriority = () => false,
}) {
  const origin = await navigator.storage.getDirectory();
  const base = await origin.getDirectoryHandle(ROOT_DIR, { create: true });
  const filesBase = await base.getDirectoryHandle(FILES_DIR, { create: true });

  // path (VFS absolute) -> { k:'file'|'dir'|'symlink', m:mode, t:target? }
  const meta = new Map();
  // path -> 'w' (write/create) | 'd' (delete) | 'r' (delete subtree,
  // then recreate). Insertion order = drain order.
  const pending = new Map();
  // Mirrors pending, for paths the caller marks low priority (the package-manager
  // caches). They ARE persisted — reused across projects and reloads — but a cold
  // install enqueues thousands of store files, and draining those first delayed the
  // user's own writes by minutes and kept the manifest from being written at all.
  const pendingLow = new Map();
  // Set by flush() (page hide): land the project paths and the index now, leave the
  // caches queued — a hiding tab must not wait for a cold install to finish.
  let flushUrgent = false;
  let draining = false;
  let manifestDirty = false;
  // The manifest is the WHOLE index serialized in one go, so its cost is O(paths
  // persisted) — and drain() used to rewrite it every time the queue emptied. When
  // OPFS is fast enough to keep up, the queue empties after almost every write, which
  // makes the total manifest bytes quadratic in the number of paths. Measured on a cold
  // Starlight install: 12,847 rewrites totalling ~2.1 GB, to index ~3,000 paths.
  // Coalescing to at most one rewrite per second collapses that to a handful with no
  // durability change that matters: this is an explicitly write-behind mirror (a few ms
  // to a second behind), file bytes are already on disk before the manifest names them,
  // and flush() on page-hide always forces a final write.
  const MANIFEST_MIN_INTERVAL_MS = 1000;
  let lastManifestWrite = 0;
  let manifestTimer = null;
  // The mirror is per ORIGIN, not per tab: a second Studio tab restores the same tree
  // and mirrors its own writes into the same OPFS directory. The index used to be
  // rewritten as a whole from THIS kernel's `meta`, so a tab that had never seen
  // another tab's paths silently dropped them — measured with two tabs: after tab A
  // wrote one file, tab B's whole project disappeared from the index and was gone on
  // the next reload. So track what this kernel changed and merge exactly that into
  // whatever the index holds on disk, under a Web Lock so two tabs cannot interleave
  // the read-modify-write.
  const owned = new Map(); // path -> "w" (write/create) | "d" (delete)
  const MANIFEST_LOCK = "vv-vfs-manifest";
  // Manifest entries NOT replayed into the VFS yet: the subtrees an embedder
  // deferred at boot (see restore's `isDeferred`). They stay in `meta`, so the
  // index merge below keeps writing them and a later hydrate() finds them.
  const deferred = new Map(); // path -> entry
  // Paths this kernel has replayed into the VFS (boot restore + hydrate).
  const materialized = new Set();

  const parts = (p) => p.split("/").filter(Boolean);

  // ---- low-level OPFS helpers (all async: handle acquisition is async) -------
  async function dirFor(path, create) {
    let h = filesBase;
    for (const part of parts(path)) h = await h.getDirectoryHandle(part, { create });
    return h;
  }
  async function parentFor(path, create) {
    const ps = parts(path);
    const name = ps.pop();
    let h = filesBase;
    for (const part of ps) h = await h.getDirectoryHandle(part, { create });
    return [h, name];
  }
  async function writeBytes(path, bytes) {
    const [dir, name] = await parentFor(path, true);
    const fh = await dir.getFileHandle(name, { create: true });
    const ah = await fh.createSyncAccessHandle();
    try {
      ah.truncate(0);
      if (bytes && bytes.length) ah.write(bytes, { at: 0 });
      ah.flush();
    } finally {
      ah.close();
    }
  }
  async function readBytes(path) {
    const [dir, name] = await parentFor(path, false);
    const fh = await dir.getFileHandle(name);
    const ah = await fh.createSyncAccessHandle();
    try {
      const size = ah.getSize();
      const buf = new Uint8Array(size);
      if (size) ah.read(buf, { at: 0 });
      return buf;
    } finally {
      ah.close();
    }
  }
  async function removePath(path) {
    try {
      const [dir, name] = await parentFor(path, false);
      await dir.removeEntry(name, { recursive: true });
    } catch {
      /* already gone / never written */
    }
  }
  // OPFS has no atomic replace: `truncate(0)` + `write()` leaves the file EMPTY for the
  // few milliseconds in between. A tab that boots during that window read an empty index,
  // failed to parse it and restored NOTHING — measured with two tabs: after a reload every
  // project was gone while the index itself was intact. So writers stage a complete copy
  // and then replace the live file, and readers fall back to the staged copy and retry
  // instead of treating "mid-write" as "nothing saved".
  const MANIFEST_STAGE = MANIFEST + ".new";
  const READ_RETRIES = 6;
  const READ_RETRY_MS = 100;
  let manifestUnreadable = false; // logged once; suppresses overwriting a bad index

  async function readJsonFile(name) {
    const fh = await base.getFileHandle(name); // throws NotFoundError when absent
    const ah = await fh.createSyncAccessHandle();
    try {
      const size = ah.getSize();
      const buf = new Uint8Array(size);
      if (size) ah.read(buf, { at: 0 });
      return JSON.parse(dec.decode(buf));
    } finally {
      ah.close();
    }
  }

  // -> { entries: Map | null, ok: boolean }. `ok:false` means an index EXISTS but could
  // not be parsed: the caller must not replace it with its own (empty) view.
  async function readManifest() {
    let present = false;
    for (let attempt = 0; attempt < READ_RETRIES; attempt++) {
      for (const name of [MANIFEST, MANIFEST_STAGE]) {
        let parsed;
        try {
          parsed = await readJsonFile(name);
        } catch (err) {
          if (err && err.name === "NotFoundError") continue; // absent: try the other copy
          present = true; // exists but is being rewritten right now
          continue;
        }
        if (Array.isArray(parsed)) return { entries: new Map(parsed), ok: true };
        present = true;
      }
      if (!present) return { entries: null, ok: true }; // first boot on this origin
      if (attempt < READ_RETRIES - 1) await new Promise((r) => setTimeout(r, READ_RETRY_MS));
    }
    return { entries: null, ok: false };
  }

  async function writeIndexFile(name, bytes) {
    const fh = await base.getFileHandle(name, { create: true });
    const ah = await fh.createSyncAccessHandle();
    try {
      ah.truncate(0);
      ah.write(bytes, { at: 0 });
      ah.flush();
    } finally {
      ah.close();
    }
  }

  // Replace the live index. `move()` is atomic where the engine has it (Chrome's OPFS);
  // without it a reader can still catch the copy mid-flight, which is survivable now that
  // the staged copy exists and is complete.
  async function replaceManifest(bytes) {
    await writeIndexFile(MANIFEST_STAGE, bytes);
    try {
      const staged = await base.getFileHandle(MANIFEST_STAGE);
      if (typeof staged.move === "function") {
        await staged.move(MANIFEST);
        return;
      }
    } catch {
      /* fall through to the copy path */
    }
    try {
      await writeIndexFile(MANIFEST, bytes);
    } finally {
      try {
        await base.removeEntry(MANIFEST_STAGE);
      } catch {
        /* already gone */
      }
    }
  }

  // navigator.locks serializes index access across tabs: the read-modify-write in
  // writeManifest and the read in restore. Where it is missing (older engine) the work
  // still runs, just without the interleave guard.
  function withManifestLock(fn) {
    const locks = typeof navigator !== "undefined" ? navigator.locks : undefined;
    return locks && typeof locks.request === "function" ? locks.request(MANIFEST_LOCK, fn) : fn();
  }

  async function writeManifest() {
    const apply = async () => {
      // Take this pass's changes up front. The drain keeps running while the index is
      // read and replaced below, and whatever it records in the meantime must survive
      // for the next pass: clearing `owned` after the write dropped those paths from
      // the index for good.
      const batch = new Map(owned);
      owned.clear();
      try {
        await mergeIntoIndex(batch);
      } catch (err) {
        // Put back what did not land, unless a newer change to the same path did.
        for (const [path, op] of batch) if (!owned.has(path)) owned.set(path, op);
        throw err;
      }
    };
    await withManifestLock(apply);
  }

  // Read-merge-write: apply only this kernel's changes, so paths another tab mirrored
  // and this kernel never saw stay in the index. With no index at all (first boot)
  // this kernel's `meta` is the best view there is. Runs under the manifest lock.
  async function mergeIntoIndex(batch) {
    const index = await readManifest();
    // An index that exists but cannot be parsed must not be replaced by this tab's
    // partial view: that turns a transient read race into real data loss. Keep the
    // changes queued and let a later pass (or the next boot) try again.
    if (!index.ok) {
      if (!manifestUnreadable) {
        manifestUnreadable = true;
        console.warn("[opfs] the VFS index is unreadable; keeping it rather than overwriting it");
      }
      throw new Error("vv-vfs: manifest unreadable");
    }
    manifestUnreadable = false;
    const onDisk = index.entries ?? new Map(meta);
    for (const [path, op] of batch) {
      if (op === "d") onDisk.delete(path);
      else {
        const e = meta.get(path);
        if (e) onDisk.set(path, e);
        else onDisk.delete(path); // vanished between enqueue and drain
      }
    }
    await replaceManifest(enc.encode(JSON.stringify([...onDisk.entries()])));
  }

  // ---- the write-behind queue ----------------------------------------------
  function queueFor(path) {
    return isLowPriority(path) ? pendingLow : pending;
  }
  function onWrite(path) {
    if (!shouldPersist(path)) return;
    const queue = queueFor(path);
    // A delete followed by a write must not leave old descendants on disk.
    queue.set(path, queue.get(path) === "d" || queue.get(path) === "r" ? "r" : "w");
    kick();
  }
  function onDelete(path) {
    if (!shouldPersist(path)) return;
    // Drop any queued writes under this subtree — they're moot now. Both queues are
    // swept: a directory can hold project paths and cache paths at once.
    const pre = path + "/";
    for (const queue of [pending, pendingLow])
      for (const k of [...queue.keys()]) if (k === path || k.startsWith(pre)) queue.delete(k);
    queueFor(path).set(path, "d");
    kick();
  }
  function onRename(from, to) {
    // rename already moved the subtree in the VFS. Mirror it as: delete the old
    // path (recursive on disk) + re-enqueue every path now living under `to`.
    if (shouldPersist(from)) onDelete(from);
    if (shouldPersist(to)) for (const p of access.walk(to)) onWrite(p);
  }

  function kick() {
    if (!draining) drain();
  }

  async function drain() {
    draining = true;
    try {
      for (;;) {
        // Project paths always win; cache paths only run with nothing urgent queued.
        const queue = pending.size ? pending : !flushUrgent && pendingLow.size ? pendingLow : null;
        if (!queue) break;
        const path = queue.keys().next().value;
        const op = queue.get(path);
        queue.delete(path);
        try {
          if (op === "d" || op === "r") {
            await removePath(path);
            meta.delete(path);
            owned.set(path, "d");
            const pre = path + "/";
            for (const k of [...meta.keys()])
              if (k.startsWith(pre)) {
                meta.delete(k);
                owned.set(k, "d");
              }
            manifestDirty = true;
          }
          if (op === "w" || op === "r") {
            const e = access.read(path); // current truth from the VFS
            if (!e) continue; // vanished between enqueue and drain
            if (e.kind === "file") await writeBytes(path, e.bytes);
            else if (e.kind === "dir") await dirFor(path, true);
            // symlink: nothing on disk, manifest carries the target
            meta.set(path, { k: e.kind, m: e.mode | 0, t: e.target });
            owned.set(path, "w");
            manifestDirty = true;
          }
        } catch {
          /* keep draining; a single bad entry shouldn't wedge the queue */
        }
        // The manifest is the only durable statement of what is on disk, so under a
        // long backlog it must not wait for the queue to empty: that is how a reload
        // can restore a tree that is minutes older than what OPFS already holds.
        if (manifestDirty && Date.now() - lastManifestWrite >= MANIFEST_MIN_INTERVAL_MS)
          await maybeWriteManifest(false);
      }
      if (manifestDirty) await maybeWriteManifest(false);
    } finally {
      draining = false;
      // Work arrived while we were finishing (cache work waits for flush()).
      if ((pending.size || pendingLow.size) && !flushUrgent) drain();
    }
  }

  // Write the manifest, unless one went out less than MANIFEST_MIN_INTERVAL_MS ago —
  // in which case arm a timer so the index still lands promptly once writes stop.
  // `force` (flush / page-hide) always writes.
  async function maybeWriteManifest(force) {
    if (!manifestDirty) return;
    const since = Date.now() - lastManifestWrite;
    if (!force && since < MANIFEST_MIN_INTERVAL_MS) {
      if (!manifestTimer && typeof setTimeout === "function") {
        manifestTimer = setTimeout(() => {
          manifestTimer = null;
          void maybeWriteManifest(true);
        }, MANIFEST_MIN_INTERVAL_MS - since);
      }
      return;
    }
    if (manifestTimer) {
      clearTimeout(manifestTimer);
      manifestTimer = null;
    }
    // Best-effort: a transient OPFS hiccup here must not escape as an unhandled
    // rejection. The flag drops BEFORE the write, so a change the drain records while
    // it is in flight raises it again instead of being cleared with it.
    manifestDirty = false;
    try {
      await writeManifest();
      lastManifestWrite = Date.now();
    } catch {
      manifestDirty = true; // retry on the next drain
    }
  }

  // Force everything queued to hit disk (best-effort; used on page hide).
  async function flush() {
    // Promise only the project paths (plus the index). Waiting for a cold install's
    // thousands of cache files would mean the tab closes before the user's own edits
    // reach the manifest.
    flushUrgent = true;
    try {
      if (draining) {
        // wait for the in-flight drain to settle, then ensure a final pass
        while (draining) await new Promise((r) => setTimeout(r, 0));
      }
      if (pending.size) await drain();
      // Unconditionally force the manifest: drain() only coalesces it, so a debounced
      // write may still be outstanding even with an empty queue. This is the one place
      // durability is promised, so it must not be skipped.
      await maybeWriteManifest(true);
    } finally {
      flushUrgent = false;
      if (pending.size || pendingLow.size) kick();
    }
  }

  // ---- restore: boot skeleton + on-demand hydrate --------------------------
  // The manifest is this origin's durable index of EVERY path (every project, every
  // package-manager cache). Replaying all of it at boot made every tab pay for every
  // project, including the ones it never opens. So the replay is split in two:
  //
  //   * restore() materializes what this tab needs regardless, and leaves the
  //     subtrees the embedder deferred in `deferred` — still indexed in `meta`, so
  //     writes, deletes and the cross-tab index merge keep working for them;
  //   * hydrate() materializes one of those subtrees when its project is opened.
  //
  // Both share materialize(): the replay order and the per-entry error handling are
  // the easy things to let drift apart.
  async function materialize(entries, onProgress) {
    // Recreate in a safe order: dirs (shallow → deep), then files, then symlinks
    // (a symlink's target may live anywhere in the tree).
    const order = { dir: 0, file: 1, symlink: 2 };
    const sorted = [...entries].sort((a, b) => {
      const ka = order[a[1].k] ?? 1;
      const kb = order[b[1].k] ?? 1;
      if (ka !== kb) return ka - kb;
      return parts(a[0]).length - parts(b[0]).length; // shallower first
    });

    const total = sorted.length;
    let n = 0;
    if (typeof onProgress === "function") onProgress(0, total);
    // Sequential replay. An earlier attempt to overlap the per-file OPFS reads
    // with bounded concurrency stalled near the end of a large restore: opening
    // many `createSyncAccessHandle`s at once runs into OPFS's exclusive-lock /
    // handle-count limits and some acquisitions never settle, wedging boot. The
    // durable speed-up for a big node_modules is the lockfile-keyed dependency
    // cache (dep-cache.js), not parallelizing this per-file loop.
    for (const [path, m] of sorted) {
      try {
        if (m.k === "dir") {
          access.mkdirp(path);
        } else if (m.k === "file") {
          const slash = path.lastIndexOf("/");
          if (slash > 0) access.mkdirp(path.slice(0, slash));
          access.writeFile(path, await readBytes(path));
        } else if (m.k === "symlink") {
          const slash = path.lastIndexOf("/");
          if (slash > 0) access.mkdirp(path.slice(0, slash));
          access.symlink(m.t, path);
        }
        n++;
        materialized.add(path);
        // Report roughly every 5% (min every 200 entries) so a big node_modules
        // restore shows a moving count instead of a long silent stall.
        if (typeof onProgress === "function" && n % Math.max(200, Math.ceil(total / 20)) === 0)
          onProgress(n, total);
      } catch {
        /* skip a corrupt entry, keep restoring the rest */
      }
    }
    if (typeof onProgress === "function") onProgress(n, total);
    return n;
  }

  // Replay the manifest into the VFS. Returns { restored, deferred } (0/0 when
  // nothing was persisted yet). Runs BEFORE the FS worker serves any syscall and
  // calls the VFS directly (via `access`), so it never re-enters the queue.
  // `options.isDeferred(path, entry)` names the entries to leave on OPFS at boot: a
  // deferred project subtree takes every entry.
  async function restore(onProgress, options = {}) {
    const isDeferred =
      typeof options.isDeferred === "function" ? options.isDeferred : () => false;
    // Read under the manifest lock, so a tab booting while another rewrites the index
    // waits for the write instead of racing it. Without the lock a read can land between
    // the copy fallback's truncate and write, and the sync access handle held while
    // reading can make the other tab's move() and its fallback both fail.
    // readManifest still retries, for engines with no Web Locks.
    const index = await withManifestLock(readManifest);
    if (!index.ok) {
      console.warn("[opfs] the VFS index is unreadable; starting with an empty workspace");
      return { restored: 0, deferred: 0 };
    }
    if (!index.entries || index.entries.size === 0) {
      return { restored: 0, deferred: 0 }; // first run on this origin
    }
    const arr = [...index.entries.entries()];

    // Drop anything `shouldPersist` now rejects. Older builds mirrored
    // node_modules file-by-file; replaying it here is the dominant cold-reopen
    // cost, and it's sourced from the dependency-cache snapshot now. Seeding
    // `meta` with kept paths only also drops the stale entries from the manifest
    // on the next drain (writeManifest serializes `meta`).
    const keep = [];
    const drop = [];
    const later = [];
    for (const e of arr) {
      if (!shouldPersist(e[0])) drop.push(e);
      else if (isDeferred(e[0])) later.push(e);
      else keep.push(e);
    }
    for (const [path, m] of keep) meta.set(path, m);
    // Deferred paths stay in the index this tab merges into — that is what lets a
    // later hydrate() find them, and what stops a write elsewhere from dropping them.
    for (const [path, m] of later) {
      meta.set(path, m);
      deferred.set(path, m);
    }
    // Those paths are not persisted any more, so their index entries are dead weight
    // everywhere — record the deletion so the merge below drops them from the shared
    // index instead of leaving every other tab to rediscover them.
    for (const [path] of drop) owned.set(path, "d");

    // Best-effort: reclaim OPFS space from legacy node_modules blobs that are no
    // longer referenced. Delete each distinct top-level node_modules subtree
    // once, OFF the boot path (non-blocking) so it never delays serving syscalls.
    const pruneRoots = new Set();
    for (const [path] of drop) {
      const i = path.indexOf("/node_modules");
      if (i >= 0) pruneRoots.add(path.slice(0, i + "/node_modules".length));
    }
    if (pruneRoots.size) {
      void (async () => {
        for (const r of pruneRoots) await removePath(r);
        try {
          await writeManifest();
        } catch {
          manifestDirty = true; // a later drain will rewrite the manifest
        }
      })();
    }

    const restored = await materialize(keep, onProgress);
    return { restored, deferred: later.length };
  }

  // Materialize the deferred entries under `roots` — a project root the user just
  // opened — and forget them from the deferred set. Idempotent: a second call for
  // the same root returns 0, because materialized paths are no longer deferred.
  async function hydrate(roots, onProgress) {
    const list = (Array.isArray(roots) ? roots : [])
      .map((r) => String(r || "").replace(/\/+$/, ""))
      .filter(Boolean);
    if (!list.length) return 0;
    const within = (p) => list.some((r) => p === r || p.startsWith(r + "/"));
    // The deferred set is the manifest as this kernel read it at boot, and a project
    // another tab created since then is only in the manifest on disk. Merge in the
    // entries under the requested roots that this kernel has never seen, so opening
    // a fresh cross-tab project does not need a reload first. Local changes that are
    // still queued are skipped: re-reading the index must not resurrect a path this
    // tab has already deleted or is in the middle of rewriting.
    const index = await readManifest();
    if (index.ok && index.entries) {
      for (const [path, m] of index.entries) {
        if (!within(path) || meta.has(path) || materialized.has(path)) continue;
        if (owned.has(path) || pending.has(path) || pendingLow.has(path)) continue;
        if (!shouldPersist(path)) continue;
        meta.set(path, m);
        deferred.set(path, m);
      }
    }
    const selected = [];
    for (const [path, m] of deferred) if (within(path)) selected.push([path, m]);
    if (!selected.length) return 0;
    const n = await materialize(selected, onProgress);
    // "Attempted" is what matters: an entry whose OPFS blob is gone (another tab
    // deleted the project after this one booted) cannot be materialized, and a retry
    // on the next open would re-read the same missing blob.
    for (const [path] of selected) deferred.delete(path);
    return n;
  }

  return { onWrite, onDelete, onRename, flush, restore, hydrate };
}
