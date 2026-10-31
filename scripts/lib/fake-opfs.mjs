// In-memory stand-ins for what packages/kernel-host/opfs-persistence.js talks to:
// the OPFS directory tree, Web Locks, and the VFS access facade. Shared by
// spike-opfs-delete-recreate.mjs and spike-opfs-multitab.mjs.
//
// The OPFS fake follows real OPFS where the mirror depends on it: a name of the
// other kind throws TypeMismatchError, a missing one NotFoundError, and a file with
// an open sync access handle refuses a second one (NoModificationAllowedError).

const notFound = (what) => Object.assign(new Error("Missing " + what), { name: "NotFoundError" });
const mismatch = (what) => Object.assign(new Error(what + " is the other kind"), { name: "TypeMismatchError" });
const locked = (what) =>
  Object.assign(new Error(what + " already has an open access handle"), { name: "NoModificationAllowedError" });

// Options:
//   move: give file handles a move(newName) that replaces the target, as Chrome does.
//         Off, the mirror takes its copy fallback.
//   beforeFileHandle(name): awaited at the start of every getFileHandle, so a test can
//         pause a write half way through.
export function fakeOpfs({ move = true, beforeFileHandle } = {}) {
  const directory = () => ({ dirs: new Map(), files: new Map(), open: new Set() });
  const root = directory();
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
      if (!dir.files.has(name) && create) dir.files.set(name, new Uint8Array());
      if (!dir.files.has(name)) throw notFound("file");
      const file = {
        async createSyncAccessHandle() {
          if (dir.open.has(name)) throw locked(name);
          dir.open.add(name);
          return {
            getSize: () => dir.files.get(name).length,
            read: (bytes) => bytes.set(dir.files.get(name)),
            truncate: (length) => dir.files.set(name, dir.files.get(name).slice(0, length)),
            write: (bytes) => dir.files.set(name, Uint8Array.from(bytes)),
            flush() {},
            close: () => dir.open.delete(name),
          };
        },
      };
      if (move)
        file.move = async (to) => {
          if (dir.open.has(name) || dir.open.has(to)) throw locked(name);
          dir.files.set(to, dir.files.get(name));
          dir.files.delete(name);
        };
      return file;
    },
    async removeEntry(name, { recursive = false } = {}) {
      if (dir.files.delete(name)) return;
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
    writeRaw(bytes, ...parts) {
      const { dir, name } = fileAt(parts, true);
      dir.files.set(name, bytes);
    },
    deleteRaw(...parts) {
      const { dir, name } = fileAt(parts);
      dir && dir.files.delete(name);
    },
  };
}

// navigator.locks with exclusive, FIFO request(name, cb), plus hold(name) so a test
// can play another tab that is holding the lock. hold() resolves once the lock is
// acquired, to a release function.
export function fakeLocks() {
  const tails = new Map();
  const request = (name, cb) => {
    const prev = tails.get(name) || Promise.resolve();
    const run = prev.then(() => cb());
    tails.set(name, run.catch(() => {}));
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

export const bytes = (s) => new TextEncoder().encode(s);
export const text = (b) => new TextDecoder().decode(b);
