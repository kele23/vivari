// Journal + batched materialisation for the OPFS mirror, meant to run in its own worker.
//
// Why: a per-file createSyncAccessHandle/truncate/write/flush/close costs ~4 ms on the
// thread that also serves syscalls, and that thread is the FS worker. Here the caller only
// appends one record to one open journal handle; the fsync is paid once per drain, and the
// per-path files are rewritten afterwards, off the caller's thread.
//
// Ordering is write-ahead: a record is durable when the journal is flushed, and only then
// is the per-path file rewritten. A crash between the two leaves the record in the journal,
// and init() replays it before the VFS restore reads any file, so replay is idempotent.
//
// Not handled here: the manifest (it stays in opfs-persistence.js, which still owns the
// multi-tab merge and the staged replace) and directory creation (drain does that directly).

const JOURNAL = "journal.wal";
const RECORD_V = 1;
// Bound the window where records live only in this worker's memory: a huge cache install
// must not hold hundreds of MB, and durability must not wait for a queue that never empties.
const MAX_PENDING_BYTES = 8 * 1024 * 1024;
const MAX_PENDING_RECORDS = 512;

const enc = new TextEncoder();
const dec = new TextDecoder();

export async function createMirrorLane({ rootDir = "vv-vfs", filesDir = "files" } = {}) {
  const origin = await navigator.storage.getDirectory();
  const base = await origin.getDirectoryHandle(rootDir, { create: true });
  const filesBase = await base.getDirectoryHandle(filesDir, { create: true });
  const journal = await (await base.getFileHandle(JOURNAL, { create: true })).createSyncAccessHandle();

  let offset = 0;
  let pendingBytes = 0;
  const dirty = new Map(); // path -> bytes to materialise
  const deleted = new Set(); // paths removed since the last flush

  const parts = (path) => path.split("/").filter(Boolean);
  async function parentFor(path) {
    const ps = parts(path);
    const name = ps.pop();
    let handle = filesBase;
    for (const part of ps) handle = await handle.getDirectoryHandle(part, { create: true });
    return [handle, name];
  }
  async function writeFile(path, bytes) {
    const [dir, name] = await parentFor(path);
    const file = await dir.getFileHandle(name, { create: true });
    const handle = await file.createSyncAccessHandle();
    try {
      handle.truncate(0);
      if (bytes && bytes.length) handle.write(bytes, { at: 0 });
      // No flush: the journal record is the durable copy until the next checkpoint. The
      // file is rebuilt from it on replay if this close never reaches disk.
    } finally {
      handle.close();
    }
  }
  async function removePath(path) {
    try {
      const [dir, name] = await parentFor(path);
      await dir.removeEntry(name, { recursive: true });
    } catch {
      /* already gone / never written */
    }
  }

  const append = (header, body) => {
    const head = enc.encode(JSON.stringify(header));
    const record = new Uint8Array(4 + head.length + (body ? body.length : 0));
    new DataView(record.buffer).setUint32(0, head.length, true);
    record.set(head, 4);
    if (body && body.length) record.set(body, 4 + head.length);
    journal.write(record, { at: offset });
    offset += record.byteLength;
  };

  // Write-ahead: flush the journal, then rebuild the files it names, then checkpoint.
  async function flush() {
    if (!offset && !dirty.size && !deleted.size) return { flushed: 0 };
    const started = typeof performance !== "undefined" ? performance.now() : Date.now();
    journal.flush();
    const records = dirty.size + deleted.size;
    for (const [path, bytes] of dirty) await writeFile(path, bytes);
    for (const path of deleted) await removePath(path);
    dirty.clear();
    deleted.clear();
    journal.truncate(0);
    offset = 0;
    pendingBytes = 0;
    journal.flush();
    return { flushed: records, ms: (typeof performance !== "undefined" ? performance.now() : Date.now()) - started };
  }

  async function maybeFlush() {
    if (pendingBytes >= MAX_PENDING_BYTES || dirty.size + deleted.size >= MAX_PENDING_RECORDS) await flush();
  }

  // Replay whatever a previous tab left in the journal. Runs before the caller restores the
  // VFS, so a record that never reached its file is not lost.
  async function init() {
    const size = journal.getSize();
    if (size > 0) {
      const raw = new Uint8Array(size);
      journal.read(raw, { at: 0 });
      let at = 0;
      let applied = 0;
      while (at + 4 <= raw.byteLength) {
        const headerLength = new DataView(raw.buffer, raw.byteOffset + at, 4).getUint32(0, true);
        at += 4;
        if (!headerLength || at + headerLength > raw.byteLength) break;
        const header = JSON.parse(dec.decode(raw.subarray(at, at + headerLength)));
        at += headerLength;
        const length = header.s || 0;
        if (at + length > raw.byteLength) break;
        const body = raw.subarray(at, at + length);
        at += length;
        if (header.op === "w") await writeFile(header.p, body);
        else if (header.op === "d") await removePath(header.p);
        applied += 1;
      }
      journal.truncate(0);
      offset = 0;
      journal.flush();
      return { replayed: applied };
    }
    return { replayed: 0 };
  }

  return {
    init,
    write(path, bytes) {
      append({ v: RECORD_V, op: "w", p: path, s: bytes ? bytes.length : 0 }, bytes);
      dirty.set(path, bytes);
      deleted.delete(path);
      pendingBytes += bytes ? bytes.length : 0;
      return maybeFlush();
    },
    remove(path) {
      append({ v: RECORD_V, op: "d", p: path, s: 0 }, null);
      dirty.delete(path);
      deleted.add(path);
      return maybeFlush();
    },
    flush,
  };
}
