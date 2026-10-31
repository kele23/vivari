// Advisory file locks with SQLite's five lock levels, held by the File System Worker.
//
// WHY THIS EXISTS. Every process (and every worker thread) here is its own Web Worker
// with its own SQLite engine, so two of them opening one database are two connections
// with two page caches. SQLite keeps those coherent through file locks: a writer takes
// RESERVED, then EXCLUSIVE, and a reader's SHARED lock is what tells it the file changed
// underneath. With no lock primitive anywhere in the syscall ABI, every xLock answered
// "granted" and two writers could interleave pages into a database neither of them wrote.
// pnpm 11 is the case that made it urgent: its store index is a SQLite file that the CLI
// and each of its worker threads open at the same time, during every install.
//
// WHY THE FS WORKER. It is the one thread every process's filesystem traffic already
// passes through, one request at a time, so a lock table there is atomic for free: no
// two lock requests are ever serviced concurrently. It also learns when a process goes
// away (`FsServer.unregister`), which is where a killed process's locks are released.
// Without that, a process killed mid-transaction would leave the database locked for
// ever and every later install would report SQLITE_BUSY.
//
// THE PROTOCOL is SQLite's own (https://www.sqlite.org/lockingv3.html), stated in terms
// of levels rather than the byte ranges os_unix.c maps them onto:
//
//   SHARED     granted unless another owner holds PENDING or EXCLUSIVE.
//   RESERVED   granted unless another owner holds RESERVED or higher.
//   EXCLUSIVE  first PENDING (unless another owner holds PENDING or EXCLUSIVE), which
//              keeps NEW readers out, then EXCLUSIVE once no other owner holds anything.
//              If readers remain, the request fails but PENDING is KEPT: the caller is
//              told it now holds PENDING and retries. That is what stops a writer from
//              starving behind a stream of readers, and it is os_unix.c's behaviour.
//
// The table never blocks. A lock that cannot be granted answers with the level the
// owner actually holds, and the caller (the SQLite VFS) turns that into SQLITE_BUSY,
// so waiting is SQLite's busy handler's job, done in the caller's own thread.
//
// What it does NOT model: anything that is not SQLite. These are not POSIX fcntl or
// flock locks and nothing but the SQLite VFS asks for them. Paths are compared as given
// (the caller resolves them), so a hard link or symlink to the same database is a
// different lock, which is the same blind spot os_unix.c has for paths it cannot stat
// to one inode, minus the inode.

export const LOCK_NONE = 0;
export const LOCK_SHARED = 1;
export const LOCK_RESERVED = 2;
export const LOCK_PENDING = 3;
export const LOCK_EXCLUSIVE = 4;

// Operations carried by OP_FILE_LOCK (packages/protocol/syscall.js).
export const FILE_LOCK_ACQUIRE = 0;
export const FILE_LOCK_RELEASE = 1;
export const FILE_LOCK_CHECK_RESERVED = 2;

export class FileLocks {
  constructor() {
    // path -> Map<ownerKey, level>. A path with no holders is deleted, so the table
    // only ever holds databases that are actually open.
    this.files = new Map();
  }

  static ownerKey(clientId, owner) {
    return clientId + ":" + owner;
  }

  _highestOther(holders, me) {
    let max = LOCK_NONE;
    for (const [key, level] of holders) {
      if (key !== me && level > max) max = level;
    }
    return max;
  }

  /** Try to raise `owner` to `level`. Returns the level it holds afterwards. */
  acquire(path, clientId, owner, level) {
    const me = FileLocks.ownerKey(clientId, owner);
    let holders = this.files.get(path);
    if (!holders) this.files.set(path, (holders = new Map()));
    const current = holders.get(me) || LOCK_NONE;
    if (level <= current) return current;
    const others = this._highestOther(holders, me);

    if (level === LOCK_SHARED) {
      if (others >= LOCK_PENDING) return this._settle(path, holders, me, current);
      holders.set(me, LOCK_SHARED);
      return LOCK_SHARED;
    }
    if (level === LOCK_RESERVED) {
      if (current < LOCK_SHARED || others >= LOCK_RESERVED) return this._settle(path, holders, me, current);
      holders.set(me, LOCK_RESERVED);
      return LOCK_RESERVED;
    }
    // EXCLUSIVE (SQLite never asks for PENDING by name; treat it as the first half).
    if (current < LOCK_SHARED) return this._settle(path, holders, me, current);
    let held = current;
    if (held < LOCK_PENDING) {
      if (others >= LOCK_PENDING) return this._settle(path, holders, me, current);
      held = LOCK_PENDING;
      holders.set(me, held);
    }
    if (level === LOCK_PENDING || others >= LOCK_SHARED) return held;
    holders.set(me, LOCK_EXCLUSIVE);
    return LOCK_EXCLUSIVE;
  }

  /** Lower `owner` to `level` (SHARED or NONE). */
  release(path, clientId, owner, level) {
    const holders = this.files.get(path);
    if (!holders) return LOCK_NONE;
    const me = FileLocks.ownerKey(clientId, owner);
    const current = holders.get(me) || LOCK_NONE;
    const next = Math.min(current, level);
    if (next <= LOCK_NONE) holders.delete(me);
    else holders.set(me, next);
    if (holders.size === 0) this.files.delete(path);
    return next;
  }

  /** xCheckReservedLock: does any OTHER owner hold RESERVED or higher? */
  checkReserved(path, clientId, owner) {
    const holders = this.files.get(path);
    if (!holders) return false;
    return this._highestOther(holders, FileLocks.ownerKey(clientId, owner)) >= LOCK_RESERVED;
  }

  /** A process went away: drop every lock any of its connections held. */
  releaseClient(clientId) {
    const prefix = clientId + ":";
    for (const [path, holders] of this.files) {
      for (const key of holders.keys()) {
        if (key.startsWith(prefix)) holders.delete(key);
      }
      if (holders.size === 0) this.files.delete(path);
    }
  }

  _settle(path, holders, me, current) {
    if (holders.size === 0) this.files.delete(path);
    return current;
  }

  /** Every lock held, for diagnostics: [{ path, owner, level }]. */
  snapshot() {
    const out = [];
    for (const [path, holders] of this.files) {
      for (const [owner, level] of holders) out.push({ path, owner, level });
    }
    return out;
  }
}

/** The FsServer-side dispatcher for one OP_FILE_LOCK request. Returns a u32 answer. */
export function serviceFileLock(locks, clientId, path, owner, op, level) {
  if (op === FILE_LOCK_ACQUIRE) return locks.acquire(path, clientId, owner, level);
  if (op === FILE_LOCK_RELEASE) return locks.release(path, clientId, owner, level);
  if (op === FILE_LOCK_CHECK_RESERVED) return locks.checkReserved(path, clientId, owner) ? 1 : 0;
  throw "EINVAL";
}
