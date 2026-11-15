// Main-thread (FS-worker) side of the mirror lane: fire-and-forget writes, one awaited
// flush. Writes are copied by structured clone on purpose: the bytes come from the VFS and
// must not be detached.

export function createMirrorLaneClient(worker) {
  let nextId = 1;
  const pending = new Map();
  let settle;
  const ready = new Promise((resolve, reject) => {
    settle = { resolve, reject };
  });

  worker.onmessage = (event) => {
    const d = event.data || {};
    if (d.type === "lane-ready") {
      if (d.ok) settle.resolve(d);
      else settle.reject(new Error(d.reason || "mirror lane unavailable"));
      return;
    }
    const entry = d.id && pending.get(d.id);
    if (!entry) return;
    pending.delete(d.id);
    if (d.ok) entry.resolve(d.result);
    else entry.reject(new Error(d.error || "mirror lane op failed"));
  };
  worker.onerror = (event) => settle.reject(new Error(event.message || "mirror worker error"));

  const call = (message) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      worker.postMessage({ ...message, id });
    });

  return {
    ready,
    write(path, bytes) {
      worker.postMessage({ type: "write", path, bytes });
    },
    remove(path) {
      worker.postMessage({ type: "remove", path });
    },
    flush() {
      return call({ type: "flush" });
    },
  };
}
