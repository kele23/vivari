// Worker entry for the OPFS mirror lane (see kernel-host/mirror-lane.js).
import { createMirrorLane } from "../../../kernel-host/mirror-lane.js";

let lane = null;
const post = (message) => self.postMessage(message);

async function main() {
  // One tab owns the journal. A second tab's lane would fight over the same handle, and a
  // lane that cannot take the lock falls back to the direct write path in opfs-persistence.
  if (typeof navigator !== "undefined" && navigator.locks) {
    let grant;
    const granted = new Promise((resolve) => {
      grant = resolve;
    });
    navigator.locks.request("vv-vfs-journal", { ifAvailable: true }, async (lock) => {
      grant(!!lock);
      if (!lock) return;
      await new Promise(() => {}); // hold the lock for this worker's lifetime
    });
    if (!(await granted)) {
      post({ type: "lane-ready", ok: false, reason: "another tab owns the journal" });
      return;
    }
  }
  lane = await createMirrorLane();
  const { replayed } = await lane.init();
  post({ type: "lane-ready", ok: true, replayed });
}

self.onmessage = async (event) => {
  const d = event.data || {};
  if (!lane) return;
  try {
    if (d.type === "write") await lane.write(d.path, d.bytes);
    else if (d.type === "remove") await lane.remove(d.path);
    else if (d.type === "flush") {
      const result = await lane.flush();
      post({ id: d.id, ok: true, result });
    }
  } catch (error) {
    const reason = String((error && error.message) || error);
    // A fire-and-forget write has no reply channel, so surface the failure on the console
    // the same way the direct path's per-entry catch does: the queue keeps draining.
    if (d.id) post({ id: d.id, ok: false, error: reason });
    else post({ type: "log", line: "  [opfs] mirror lane write failed: " + reason });
  }
};

main().catch((error) => post({ type: "lane-ready", ok: false, reason: String((error && error.message) || error) }));
