// Spike (OFFLINE, Wasm-free): the OPFS write-behind mirror must not resurrect a
// deleted subtree when the same path is recreated before the drain reaches it.
//
// WHY THIS EXISTS. The queue is `path -> op`, and a delete followed by a write of
// the same path used to coalesce into a plain write: `pending.set(path, 'w')`
// replaced the queued 'd'. That only happens while the drain is busy with another
// entry (an idle drain picks the delete up synchronously), which is exactly the
// state during an install or a scaffold. The live VFS looked right, but the old
// children stayed in the manifest and came back on the next reload. The same
// coalescing broke a path that changed KIND — a file replaced by a directory, or
// the reverse — because the write then ran against an OPFS entry of the other kind,
// threw, and the catch in drain() swallowed it, leaving the old kind in the manifest.
//
// HOW IT IS GATED. The real opfs-persistence.js runs against an in-memory OPFS and
// an in-memory VFS facade; each case keeps the drain busy on an unrelated path so
// the delete and the write coalesce, then restores into a fresh VFS and compares.
// The fake OPFS (scripts/lib/fake-opfs.mjs) throws TypeMismatchError on a name of
// the other kind, as real OPFS does, so the kind-change cases fail the way they fail
// in a browser.
//
//   run:  node scripts/spike-opfs-delete-recreate.mjs

import { createOpfsPersistence } from "../packages/kernel-host/opfs-persistence.js";
import { fakeOpfs, fakeVfs, bytes, text } from "./lib/fake-opfs.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};

const rmTree = (vfs, path) => {
  for (const k of vfs.walk(path)) vfs.entries.delete(k);
};

// One case = a fresh OPFS, a seeded + flushed tree, a mutation made while the
// drain is busy, a flush, then a restore into a fresh VFS.
async function runCase(seed, mutate) {
  const storage = fakeOpfs();
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage } });
  const vfs = fakeVfs();
  const persistence = await createOpfsPersistence({ access: vfs });
  vfs.writeFile("/busy.txt", bytes("busy"));
  seed(vfs);
  for (const path of [...vfs.entries.keys()].sort()) persistence.onWrite(path);
  await persistence.flush();

  // The first onWrite starts a drain that awaits OPFS, so everything enqueued
  // after it in this same turn coalesces in `pending` before the drain sees it.
  persistence.onWrite("/busy.txt");
  mutate(vfs, persistence);
  await persistence.flush();

  const reopened = fakeVfs();
  await (await createOpfsPersistence({ access: reopened })).restore();
  return reopened;
}

const originalNavigator = globalThis.navigator;
try {
  console.log("== a directory deleted and recreated before the drain reaches it ==");
  {
    const r = await runCase(
      (vfs) => {
        vfs.mkdirp("/w");
        vfs.mkdirp("/w/old");
        vfs.writeFile("/w/old/file.txt", bytes("old"));
      },
      (vfs, p) => {
        rmTree(vfs, "/w");
        p.onDelete("/w");
        vfs.mkdirp("/w");
        p.onWrite("/w");
      },
    );
    ok(!r.entries.has("/w/old") && !r.entries.has("/w/old/file.txt"), "the old children do not come back after reload");
    ok(r.entries.get("/w")?.kind === "dir", "…and the recreated directory is there");
    ok(r.entries.has("/busy.txt"), "…and an unrelated path is untouched");
  }

  console.log("\n== a recreated directory gets a new child in the same turn ==");
  {
    const r = await runCase(
      (vfs) => {
        vfs.mkdirp("/w");
        vfs.writeFile("/w/old.txt", bytes("old"));
      },
      (vfs, p) => {
        rmTree(vfs, "/w");
        p.onDelete("/w");
        vfs.mkdirp("/w");
        p.onWrite("/w");
        vfs.writeFile("/w/new.txt", bytes("new"));
        p.onWrite("/w/new.txt");
      },
    );
    ok(!r.entries.has("/w/old.txt"), "the old child is gone");
    ok(r.entries.has("/w/new.txt") && text(r.entries.get("/w/new.txt").bytes) === "new", "…and the new child is persisted with its bytes");
  }

  console.log("\n== a path that changes kind ==");
  {
    const r = await runCase(
      (vfs) => vfs.writeFile("/x", bytes("was a file")),
      (vfs, p) => {
        vfs.entries.delete("/x");
        p.onDelete("/x");
        vfs.mkdirp("/x");
        p.onWrite("/x");
      },
    );
    ok(r.entries.get("/x")?.kind === "dir", "a file replaced by a directory restores as a directory");
  }
  {
    const r = await runCase(
      (vfs) => {
        vfs.mkdirp("/y");
        vfs.writeFile("/y/child.txt", bytes("child"));
      },
      (vfs, p) => {
        rmTree(vfs, "/y");
        p.onDelete("/y");
        vfs.writeFile("/y", bytes("now a file"));
        p.onWrite("/y");
      },
    );
    ok(r.entries.get("/y")?.kind === "file" && text(r.entries.get("/y").bytes) === "now a file", "a directory replaced by a file restores as that file");
    ok(!r.entries.has("/y/child.txt"), "…without the directory's old child");
  }

  console.log("\n== a plain delete is still a delete ==");
  {
    const r = await runCase(
      (vfs) => {
        vfs.mkdirp("/z");
        vfs.writeFile("/z/f.txt", bytes("f"));
      },
      (vfs, p) => {
        rmTree(vfs, "/z");
        p.onDelete("/z");
      },
    );
    ok(!r.entries.has("/z") && !r.entries.has("/z/f.txt"), "a deleted subtree stays deleted");
  }

  console.log("\n== a cold cache flood must not delay a project write ==");
  {
    // The mirror persists the package-manager caches, and a cold install enqueues
    // thousands of store files. A project write made during that flood used to sit
    // behind the whole cache queue — and a reload discards the in-memory queue, so
    // the edit was simply lost. It must be durable after flush() while the rest of
    // the cache queue is still pending.
    const lowPrefix = "/home/user/.cache/pnpm/";
    const storage = fakeOpfs();
    Object.defineProperty(globalThis, "navigator", { configurable: true, value: { storage } });
    const vfs = fakeVfs();
    const persistence = await createOpfsPersistence({
      access: vfs,
      isLowPriority: (p) => p.startsWith(lowPrefix),
    });
    for (let i = 0; i < 200; i++) {
      const p = lowPrefix + "file-" + i + ".json";
      vfs.writeFile(p, bytes("cache"));
      persistence.onWrite(p);
    }
    vfs.writeFile("/home/user/projects/app/src/App.tsx", bytes("project"));
    persistence.onWrite("/home/user/projects/app/src/App.tsx");
    await persistence.flush();

    const reopened = fakeVfs();
    await (await createOpfsPersistence({ access: reopened })).restore();
    const app = reopened.entries.get("/home/user/projects/app/src/App.tsx");
    ok(app?.kind === "file" && text(app.bytes) === "project", "the project write survives the flush");
    ok(!reopened.entries.has(lowPrefix + "file-199.json"), "…and flush() did not wait for the cache queue");
  }
} finally {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
}

console.log("\nRESULT: " + (failed ? `FAIL (${failed})` : "PASS — a delete is never lost to the write that follows it"));
process.exit(failed ? 1 : 0);
