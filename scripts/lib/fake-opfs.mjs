// In-memory stand-ins for what the OPFS mirror's two halves talk to: the OPFS
// directory tree (opfs-persistence.js and mirror-lane.js), Web Locks, and the VFS
// access facade. Shared by spike-opfs-delete-recreate.mjs, spike-opfs-multitab.mjs
// and spike-opfs-mirror-lane.mjs.
//
// The OPFS fake follows real OPFS where the mirrors depend on it: a name of the
// other kind throws TypeMismatchError, a missing one NotFoundError, a file with an
// open sync access handle refuses a second one (NoModificationAllowedError), the
// handle's read()/write() honour { at } and return a byte count, and getFile()
// reports lastModified. The last two are what the journal lane needs: it appends
// records at a running offset, and replay's stale guard compares a record's
// timestamp against the body file's lastModified.

const enc = new TextEncoder();
const dec = new TextDecoder();

const notFound = (what) => Object.assign(new Error("Missing " + what), { name: "NotFoundError" });
const mismatch = (what) => Object.assign(new Error(what + " is the other kind"), { name: "TypeMismatchError" });
const locked = (what) =>
  Object.assign(new Error(what + " already has an open access handle"), { name: "NoModificationAllowedError" });

// Options:
//   move: give file handles a move(newName) that replaces the target, as Chrome does.
//         Off, the mirror takes its copy fallback.
//   beforeFileHandle(name): awaited at the start of every getFileHandle, so a test can
//         pause a write half way through.
//   now(): the clock every lastModified is stamped from. Default Date.now; a test that
//         drives replay's stale guard overrides it with a clock it can set.
//   failWrite(name): return an Error to make the next sync-access-handle write to that
//         file throw it, or nothing otherwise. Lets one bad body be injected without
//         breaking OPFS for every path.
//   onAccessHandle(name, phase): called with "open"/"close" around every sync access
//         handle, so a test can assert materialisation passes never overlap.
export function fakeOpfs({
  move = true,
  beforeFileHandle,
  now = () => Date.now(),
  failWrite,
  onAccessHandle,
} = {}) {
  const directory = () => ({ dirs: new Map(), files: new Map(), mtimes: new Map(), open: new Set() });
  const root = directory();
  const stamp = (dir, name) => dir.mtimes.set(name, now());
  const handle = (dir) => ({
    async getDirectoryHandle(name, { create = false } = {}) {
      if (dir.files.has(name)) throw mismatch(name);
      if (!dir.dirs.has(name) && create) dir.dirs.set(name, directory());
      if (!dir.dirs.has(name)) throw notFound("directory");
      return handle(dir.dirs.get(name));
    },
    async getFileHandle(name, { create = false } = {}) {
      if (beforeFileHandle) await beforeFileHandle(name);
      if (dir.dirs.has(name)) throw mismatch(name);
      if (!dir.files.has(name) && create) {
        dir.files.set(name, new Uint8Array());
        stamp(dir, name);
      }
      if (!dir.files.has(name)) throw notFound("file");
      const file = {
        // What replay's stale guard and readManifest() read: lastModified as it is on
        // "disk" right now. Snapshot the bytes, like the real Blob would.
        async getFile() {
          const data = dir.files.get(name);
          if (!data) throw notFound("file");
          const copy = data.slice();
          return {
            name,
            lastModified: dir.mtimes.has(name) ? dir.mtimes.get(name) : 0,
            size: copy.length,
            type: "",
            text: async () => dec.decode(copy),
            arrayBuffer: async () => copy.buffer,
          };
        },
        async createSyncAccessHandle() {
          if (dir.open.has(name)) throw locked(name);
          dir.open.add(name);
          if (onAccessHandle) onAccessHandle(name, "open");
          let closed = false;
          const close = () => {
            if (closed) return;
            closed = true;
            dir.open.delete(name);
            if (onAccessHandle) onAccessHandle(name, "close");
          };
          return {
            getSize: () => dir.files.get(name).length,
            // Real handles return the bytes read and honour { at }; the journal reads
            // its whole WAL in one call at offset 0 and trusts the return value.
            read(bytes, options = {}) {
              const at = options && typeof options.at === "number" ? options.at : 0;
              const src = dir.files.get(name);
              const n = Math.max(0, Math.min(bytes.length, src.length - at));
              if (n > 0) bytes.set(src.subarray(at, at + n));
              return n;
            },
            truncate(length) {
              dir.files.set(name, dir.files.get(name).slice(0, length));
              stamp(dir, name);
            },
            // Write at { at } (default 0), growing the file and zero-filling any gap,
            // and return the byte count: a short write is an error the lane checks.
            write(bytes, options = {}) {
              if (failWrite) {
                const injected = failWrite(name);
                if (injected) throw injected;
              }
              const at = options && typeof options.at === "number" ? options.at : 0;
              const cur = dir.files.get(name);
              const end = at + bytes.length;
              const next = end > cur.length ? new Uint8Array(end) : cur;
              if (next !== cur) next.set(cur);
              next.set(bytes, at);
              dir.files.set(name, next);
              stamp(dir, name);
              return bytes.length;
            },
            flush() {},
            close,
          };
        },
      };
      if (move)
        file.move = async (to) => {
          if (dir.open.has(name) || dir.open.has(to)) throw locked(name);
          dir.files.set(to, dir.files.get(name));
          dir.files.delete(name);
          if (dir.mtimes.has(name)) {
            dir.mtimes.set(to, dir.mtimes.get(name));
            dir.mtimes.delete(name);
          }
        };
      return file;
    },
    async removeEntry(name, { recursive = false } = {}) {
      if (dir.files.delete(name)) {
        dir.mtimes.delete(name);
        return;
      }
      const child = dir.dirs.get(name);
      if (!child) throw notFound("entry");
      if (!recursive && (child.dirs.size || child.files.size)) throw new Error("NotEmptyError");
      dir.dirs.delete(name);
    },
  });
  // Raw access for tests that need to plant or inspect a file directly.
  const fileAt = (parts, create = false) => {
    let dir = root;
    for (const p of parts.slice(0, -1)) {
      if (create && !dir.dirs.has(p)) dir.dirs.set(p, directory());
      dir = dir && dir.dirs.get(p);
    }
    return { dir, name: parts[parts.length - 1] };
  };
  return {
    getDirectory: async () => handle(root),
    readRaw(...parts) {
      const { dir, name } = fileAt(parts);
      return dir && dir.files.get(name);
    },
    // Existence of a DIRECTORY (bodies have readRaw; a re-created directory left by the
    // failed-delete requeue is only observable as a directory in the fake tree).
    hasDirectoryRaw(...parts) {
      const { dir, name } = fileAt(parts);
      return !!(dir && dir.dirs.has(name));
    },
    writeRaw(bytes, ...parts) {
      const { dir, name } = fileAt(parts, true);
      dir.files.set(name, bytes);
      stamp(dir, name);
    },
    deleteRaw(...parts) {
      const { dir, name } = fileAt(parts);
      if (!dir) return;
      dir.files.delete(name);
      dir.mtimes.delete(name);
    },
    // Simulate a tab dying: the browser drops every sync access handle the tab held,
    // so another lane can open the same journal. The handles are dead afterwards.
    closeAllHandles() {
      let closed = 0;
      const walk = (dir) => {
        for (const name of dir.open) {
          closed += 1;
          if (onAccessHandle) onAccessHandle(name, "close");
        }
        dir.open.clear();
        for (const child of dir.dirs.values()) walk(child);
      };
      walk(root);
      return closed;
    },
  };
}

// navigator.locks with exclusive, FIFO request(name, cb), the request(name,
// { ifAvailable: true }, cb) form discardJournalIfUnlocked uses, plus hold(name) so a
// test can play another tab that is holding the lock.
//
// An ifAvailable request must be answered from who HOLDS the lock right now, never by
// queueing behind them: the whole point is to refuse when a live lane owns the journal.
export function fakeLocks() {
  const tails = new Map(); // name -> tail of the FIFO queue
  const held = new Set(); // names currently held by a running callback
  const queued = new Map(); // name -> requests posted but not yet settled
  const bump = (name, by) => {
    const next = (queued.get(name) || 0) + by;
    if (next > 0) queued.set(name, next);
    else queued.delete(name);
  };
  const request = (name, optionsOrCb, maybeCb) => {
    const cb = typeof optionsOrCb === "function" ? optionsOrCb : maybeCb;
    const options = typeof optionsOrCb === "function" ? {} : optionsOrCb || {};
    if (typeof cb !== "function") throw new TypeError("fakeLocks.request() needs a callback");
    const lock = { name, mode: "exclusive" };
    if (options.ifAvailable) {
      if (held.has(name) || queued.has(name)) return Promise.resolve().then(() => cb(null));
      held.add(name);
      const run = Promise.resolve()
        .then(() => cb(lock))
        .finally(() => held.delete(name));
      tails.set(name, run.then(() => {}, () => {}));
      return run;
    }
    const prev = tails.get(name) || Promise.resolve();
    bump(name, 1);
    const run = prev.then(async () => {
      held.add(name);
      try {
        return await cb(lock);
      } finally {
        held.delete(name);
      }
    });
    run.then(
      () => bump(name, -1),
      () => bump(name, -1),
    );
    tails.set(name, run.then(() => {}, () => {}));
    return run;
  };
  return {
    request,
    hold(name) {
      return new Promise((acquired) => {
        request(name, () => new Promise((release) => acquired(release)));
      });
    },
  };
}

export function fakeVfs() {
  const entries = new Map();
  return {
    entries,
    read: (path) => entries.get(path),
    walk: (path) => [...entries.keys()].filter((key) => key === path || key.startsWith(path + "/")),
    mkdirp: (path) => entries.set(path, { kind: "dir", mode: 0o755 }),
    writeFile: (path, bytes) => entries.set(path, { kind: "file", mode: 0o644, bytes }),
    symlink: (target, path) => entries.set(path, { kind: "symlink", mode: 0o777, target }),
  };
}

export const bytes = (s) => enc.encode(s);
export const text = (b) => dec.decode(b);
