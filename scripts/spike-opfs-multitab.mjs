// Spike (OFFLINE, Wasm-free): two Studio tabs share one OPFS mirror without losing
// each other's files.
//
// WHY THIS EXISTS. The mirror is per ORIGIN, not per tab. A second tab restores the
// same tree and mirrors its own writes into the same directory and the same
// manifest.json. Before #22 each tab rewrote the whole index from its own `meta`, so
// a tab that had never seen the other tab's paths dropped them, and a tab that still
// remembered a file the other tab deleted brought it back. #22 made each tab merge
// only its own changes into the index on disk, under a Web Lock, replacing the file
// through a staged copy. The follow-up made restore() read under the same lock and
// stopped a write from dropping changes recorded while it was in flight.
//
// HOW IT IS GATED. Each "tab" is a real createOpfsPersistence over its own fake VFS;
// all of them share one fake OPFS and one fake navigator.locks
// (scripts/lib/fake-opfs.mjs), the way tabs on one origin share both.
//
//   run:  node scripts/spike-opfs-multitab.mjs

import { createOpfsPersistence } from "../packages/kernel-host/opfs-persistence.js";
import { fakeOpfs, fakeLocks, fakeVfs, bytes, text } from "./lib/fake-opfs.mjs";

let failed = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ✓ " : "  ✗ ") + msg);
  if (!cond) failed++;
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const MANIFEST = ["vv-vfs", "manifest.json"];
const STAGED = ["vv-vfs", "manifest.json.new"];

// One origin: a shared OPFS, and Web Locks unless a case asks for an engine without.
function origin({ locks = true, ...opfs } = {}) {
  const storage = fakeOpfs(opfs);
  const lockManager = locks ? fakeLocks() : undefined;
  Object.defineProperty(globalThis, "navigator", {
    configurable: true,
    value: lockManager ? { storage, locks: lockManager } : { storage },
  });
  return { storage, locks: lockManager };
}

// A tab boots: a fresh VFS, restored from whatever the origin holds.
async function openTab() {
  const vfs = fakeVfs();
  const p = await createOpfsPersistence({ access: vfs });
  await p.restore();
  const write = (path, body) => {
    vfs.writeFile(path, bytes(body));
    p.onWrite(path);
  };
  const remove = (path) => {
    for (const k of vfs.walk(path)) vfs.entries.delete(k);
    p.onDelete(path);
  };
  return { vfs, p, write, remove };
}

const quietly = async (fn) => {
  const warn = console.warn;
  console.warn = () => {};
  try {
    return await fn();
  } finally {
    console.warn = warn;
  }
};

const originalNavigator = globalThis.navigator;
try {
  for (const move of [true, false]) {
    console.log(`\n== two tabs keep each other's files (${move ? "move()" : "copy fallback, no move()"}) ==`);
    const { storage } = origin({ move });
    const a = await openTab();
    const b = await openTab(); // booted before tab A wrote anything
    a.write("/projects/react/App.tsx", "react");
    await a.p.flush();
    b.write("/projects/vue/App.vue", "vue");
    await b.p.flush();
    let r = (await openTab()).vfs;
    ok(text(r.entries.get("/projects/react/App.tsx")?.bytes ?? new Uint8Array()) === "react", "tab A's file survives tab B's write");

    a.write("/projects/react/main.tsx", "react main");
    await a.p.flush();
    r = (await openTab()).vfs;
    ok(text(r.entries.get("/projects/vue/App.vue")?.bytes ?? new Uint8Array()) === "vue", "tab B's file survives tab A's next write");
    ok(r.entries.has("/projects/react/main.tsx"), "…and tab A's latest file is there too");
    if (move) ok(!storage.readRaw(...STAGED), "the staged copy does not outlive the write");
  }

  console.log("\n== a delete in one tab is not undone by the other ==");
  {
    // A directory, because it restores with no bytes behind it: a stale index entry
    // for a deleted FILE is skipped at restore (its bytes are gone), so only the
    // index would show the bug, while a directory visibly comes back.
    const { storage } = origin();
    const a = await openTab();
    a.vfs.mkdirp("/projects/old");
    a.p.onWrite("/projects/old");
    a.write("/projects/old/notes.txt", "old");
    await a.p.flush();
    const b = await openTab(); // boots seeing projects/old
    ok(b.vfs.entries.has("/projects/old/notes.txt"), "tab B restored what tab A wrote");
    b.remove("/projects/old");
    await b.p.flush();
    a.write("/projects/a.txt", "a"); // tab A still has projects/old in its own view
    await a.p.flush();

    const index = new Map(JSON.parse(text(storage.readRaw(...MANIFEST))));
    ok(!index.has("/projects/old") && !index.has("/projects/old/notes.txt"), "the index does not list what tab B deleted");
    const r = (await openTab()).vfs;
    ok(!r.entries.has("/projects/old"), "…so the deleted directory does not come back on reload");
    ok(r.entries.has("/projects/a.txt"), "…and tab A's new file is there");
  }

  console.log("\n== a reader never mistakes a half-written index for an empty one ==");
  {
    const { storage } = origin({ locks: false });
    const a = await openTab();
    a.write("/projects/app/index.js", "app");
    await a.p.flush();
    const good = storage.readRaw(...MANIFEST);

    // The live file is cut short and a complete staged copy sits next to it.
    storage.writeRaw(good.slice(0, 3), ...MANIFEST);
    storage.writeRaw(good, ...STAGED);
    let r = (await openTab()).vfs;
    ok(r.entries.has("/projects/app/index.js"), "a truncated index falls back to the staged copy");

    // The live file is empty for a moment and there is no staged copy.
    storage.deleteRaw(...STAGED);
    storage.writeRaw(new Uint8Array(), ...MANIFEST);
    setTimeout(() => storage.writeRaw(good, ...MANIFEST), 150);
    r = (await openTab()).vfs;
    ok(r.entries.has("/projects/app/index.js"), "an empty index is retried until the write lands");
  }

  console.log("\n== an index that cannot be read is never overwritten ==");
  {
    const { storage } = origin({ locks: false });
    storage.writeRaw(bytes("{not json"), ...MANIFEST);
    const a = await quietly(openTab);
    a.write("/projects/x.txt", "x");
    await quietly(() => a.p.flush());
    ok(text(storage.readRaw(...MANIFEST)) === "{not json", "a tab's own view is not written over an unreadable index");
  }

  console.log("\n== a tab that boots while another rewrites the index waits for it ==");
  {
    // Another tab holds the lock with the live index half-written for longer than
    // readManifest's retries (about 0.6 s). Reading under the lock waits for the
    // write; reading without it gives up and boots an empty workspace.
    const { storage, locks } = origin();
    const a = await openTab();
    a.write("/projects/app/index.js", "app");
    await a.p.flush();
    const good = storage.readRaw(...MANIFEST);

    const release = await locks.hold("vv-vfs-manifest");
    storage.writeRaw(good.slice(0, 3), ...MANIFEST);
    const booting = quietly(openTab);
    await sleep(900);
    storage.writeRaw(good, ...MANIFEST);
    release();
    const r = (await booting).vfs;
    ok(r.entries.has("/projects/app/index.js"), "restore() waited for the lock and restored the project");
  }

  console.log("\n== a change made while the index is being written is not dropped ==");
  {
    // Pause the next index write at its staged copy, record another change while it
    // waits, then let it finish. That change has to reach the index on the next pass.
    let pause = null;
    const { storage } = origin({
      beforeFileHandle: (name) => (name === STAGED[1] && pause ? pause() : undefined),
    });
    const a = await openTab();
    a.write("/projects/one.txt", "1");
    await a.p.flush();

    let reached, resume;
    const atPause = new Promise((r) => (reached = r));
    const held = new Promise((r) => (resume = r));
    pause = () => {
      pause = null;
      reached();
      return held;
    };
    a.write("/projects/two.txt", "2");
    const inFlight = a.p.flush();
    await atPause;
    a.write("/projects/three.txt", "3"); // recorded while the index write is paused
    await sleep(20);
    resume();
    await inFlight;
    await a.p.flush();

    const index = new Map(JSON.parse(text(storage.readRaw(...MANIFEST))));
    ok(index.has("/projects/two.txt"), "the change being written lands");
    ok(index.has("/projects/three.txt"), "…and so does the one recorded while it was in flight");
    const r = (await openTab()).vfs;
    ok(r.entries.has("/projects/three.txt"), "…so it survives a reload");
  }
} finally {
  Object.defineProperty(globalThis, "navigator", { configurable: true, value: originalNavigator });
}

console.log("\nRESULT: " + (failed ? `FAIL (${failed})` : "PASS: tabs on one origin share the mirror without losing files"));
process.exit(failed ? 1 : 0);
