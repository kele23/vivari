// IN-VM acceptance for the breakpoint debugger's SSR eval seam (ticket kele23/vivari#5).
// NET tier: boots the real kernel (Rust/Wasm VFS + process workers), installs real
// vite in-VM, and proves the ticket's literal acceptance end to end:
//
//   a Vite SSR backend running INSIDE the WebContainer, a breakpoint set on an SSR
//   module's ORIGINAL .ts source line, an HTTP request that drives vite.ssrLoadModule
//   through the real ModuleRunner -> Debugger.paused at that exact source line (the
//   sourcemap remap working in-VM, not just offline) -> evaluateOnCallFrame reads a
//   plain local -> stepOver onto the next source line -> resume -> the HTTP response
//   completes with the expected body. Plus: node_modules stays excluded, a second
//   request still serves, and a control boot WITHOUT VV_DEBUG serves normally with
//   zero debug targets (zero-cost-when-off, in-VM).
//
// Why this is a separate spike from spike-debugger-ssr-seam.mjs: that one drives the
// seam against the REAL vite ModuleRunner but on the HOST, with a fake fetchModule
// transport and no kernel. This one runs the whole stack in the guest — the seam is
// installed by packages/runtime/index.js's VV_DEBUG attach block (patching
// %AsyncFunction.prototype%.constructor before vite loads), the SSR body reaches it
// through vite's own ESModulesEvaluator, and the CDP commands ride the real debug SAB
// / postMessage routing in packages/kernel-host/kernel.js. The harness does not wire
// debug callbacks, so this spike sets kernel.onDebugTarget / kernel.onDebugEvent and
// drives kernel.debugCommand(pid, json) itself.
//
// Project shape (one guest process, minimal footprint — vite only):
//   server.mjs  plain JS through the require loader: createServer(middlewareMode) +
//               node:http; each GET /api calls vite.ssrLoadModule('/src/api.ts').
//   src/api.ts  the SSR module evaluated through ModuleRunner (NOT the loader): a
//               handler with a clear local (`local`) and a breakpoint line (`total`).
//   src/dep.ts  a relative dep so the SSR import-rewrite path is exercised too.
//
// Run (Node 22+, needs network for npm):  node scripts/spike-debugger-ssr.mjs
// Env knobs: VV_LIVE=1 (stream guest output), VV_INSTALL_TIMEOUT, VV_BIND_TIMEOUT.

import { bootSpikeKernel, writeProject, npmInstall, waitListen, defaultEnv, httpGet } from "./lib/spike-harness.mjs";

// In-VM vite install can take minutes on a cold cache; give it room. vite 8's first
// boot also pays for the rolldown wasm binding init, so widen the bind budget too.
process.env.VV_INSTALL_TIMEOUT = process.env.VV_INSTALL_TIMEOUT || "600000";
process.env.VV_BIND_TIMEOUT = process.env.VV_BIND_TIMEOUT || "180000";

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else {
    failures++;
    console.error(" FAIL " + msg);
  }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(pred, ms, label) {
  const t0 = Date.now();
  while (!pred() && Date.now() - t0 < ms) await sleep(20);
  if (!pred()) console.error("  (waitFor timed out: " + label + ")");
  return pred();
}

const DIR = "/ssr-app";
const PORT = 3100;
const API_FILE = DIR + "/src/api.ts";
const API_URL = "file://" + API_FILE;
const DEP_URL = "file://" + DIR + "/src/dep.ts";
// Original source line 5: `const total = local + 1;` (0-based 4). `local` is live
// there (=== 42); `total` is in TDZ until the line runs. Mirrors the offline fixture.
const BP_LINE0 = 4;

const API_TS = `import { base } from "./dep";
export interface Opts { id: number }
export function handler(opts: Opts): number {
  const local = opts.id * 2 + base;
  const total = local + 1;
  return total;
}
`;
const DEP_TS = `// dependency module
export const base: number = 0;
`;

const SERVER_MJS = `import { createServer } from 'vite';
import http from 'node:http';

async function main() {
  const vite = await createServer({
    configFile: false,
    root: process.cwd(),
    logLevel: 'warn',
    appType: 'custom',
    server: { middlewareMode: true, hmr: false, watch: null },
    optimizeDeps: { noDiscovery: true, include: [] },
  });
  const server = http.createServer(async (req, res) => {
    if (req.url && req.url.startsWith('/api')) {
      try {
        const mod = await vite.ssrLoadModule('/src/api.ts');
        const answer = mod.handler({ id: 21 });
        res.statusCode = 200;
        res.setHeader('content-type', 'application/json');
        res.end(JSON.stringify({ answer }));
      } catch (e) {
        res.statusCode = 500;
        res.end(String((e && e.stack) || e));
      }
    } else {
      res.statusCode = 404;
      res.end('not found');
    }
  });
  server.listen(${PORT}, () => console.log('SSR listening on ${PORT}'));
}
main().catch((e) => { console.error('BOOT_ERR ' + ((e && e.stack) || e)); process.exit(1); });
`;

const PKG = JSON.stringify(
  { name: "ssr-debug-spike", private: true, version: "0.0.0", type: "module", dependencies: { vite: "^8.0.0" } },
  null,
  2,
);

const FILES = { "package.json": PKG, "server.mjs": SERVER_MJS, "src/api.ts": API_TS, "src/dep.ts": DEP_TS };

// ── boot + install ────────────────────────────────────────────────────────────
const tBoot = Date.now();
const h = await bootSpikeKernel();
writeProject(h.kernel, DIR, FILES);
const inst = await npmInstall(h, { dir: DIR });
assert(inst.code === 0, "npm install vite exited 0 (in-VM)");
if (inst.code !== 0) {
  console.error("Cannot proceed without a vite install. Blocking error above.");
  process.exit(1);
}
const installMs = Date.now() - tBoot;

// ── debug wiring (the harness does not do this) ───────────────────────────────
let targetPid = null;
const targetInfos = [];
const responses = new Map(); // id -> {id,result|error}
const scriptParsedUrls = [];
const pausedEvents = [];
const resolvedBps = [];
let localEvalId = null;
let totalEvalId = null;
let bpRespId = null;
let cmdSeq = 0;
let autoResume = false; // after the scripted pauses, never wedge on an extra pause

const sendTo = (pid, method, params) => {
  const id = ++cmdSeq;
  h.kernel.debugCommand(pid, JSON.stringify({ id, method, params: params || {} }));
  return id;
};

h.kernel.onDebugTarget = (pid, added, info) => {
  if (!added) return;
  targetInfos.push({ pid, command: info.command });
  if (info.command === "node" && targetPid == null) {
    // The guest server process (we launch `node server.mjs` directly, so it IS the
    // node child — no sh/npm wrapper to skip). Canonical attach flow over the SAB
    // start gate: enable -> setBreakpointByUrl on the ORIGINAL .ts line -> open gate.
    targetPid = pid;
    sendTo(pid, "Debugger.enable");
    bpRespId = sendTo(pid, "Debugger.setBreakpointByUrl", { url: API_URL, lineNumber: BP_LINE0 });
    sendTo(pid, "Runtime.runIfWaitingForDebugger");
  } else {
    // worker_threads / children inheriting VV_DEBUG (e.g. rolldown's wasi workers):
    // open their start gate promptly so they do not each burn the 2.5s timeout, but
    // do NOT enable the debugger there — we only debug the server process.
    sendTo(pid, "Runtime.runIfWaitingForDebugger");
  }
};

h.kernel.onDebugEvent = (pid, data) => {
  if (pid !== targetPid) return; // ignore child-thread debug noise
  let msg;
  try {
    msg = JSON.parse(data);
  } catch {
    return;
  }
  if (msg.id != null) {
    responses.set(msg.id, msg);
    return;
  }
  if (msg.method === "Debugger.scriptParsed") scriptParsedUrls.push(msg.params.url);
  if (msg.method === "Debugger.breakpointResolved") resolvedBps.push(msg.params);
  if (msg.method === "Debugger.paused") {
    pausedEvents.push(msg);
    const n = pausedEvents.length;
    const cf = msg.params.callFrames[0];
    if (n === 1) {
      localEvalId = sendTo(pid, "Debugger.evaluateOnCallFrame", { callFrameId: cf.callFrameId, expression: "local" });
      sendTo(pid, "Debugger.stepOver");
    } else if (n === 2) {
      totalEvalId = sendTo(pid, "Debugger.evaluateOnCallFrame", { callFrameId: cf.callFrameId, expression: "total" });
      sendTo(pid, "Debugger.resume");
      autoResume = true;
    } else if (autoResume) {
      sendTo(pid, "Debugger.resume");
    }
  }
};

// ── run the server under VV_DEBUG and wait for it to bind ─────────────────────
const tServe = Date.now();
const bound = await waitListen(h, {
  dir: DIR,
  port: PORT,
  argv: ["server.mjs"],
  env: { ...defaultEnv(DIR), VV_DEBUG: "1" },
});
assert(bound, "SSR server bound its port under VV_DEBUG=1");
assert(targetPid != null, "a node debug target was announced (the server, not sh/npm)");
if (!bound || targetPid == null) {
  console.error("\n---- guest output tail ----\n" + h.out.join("").slice(-4000));
  process.exit(1);
}
const serveMs = Date.now() - tServe;
console.log("  debug targets announced: " + JSON.stringify(targetInfos));

// The breakpoint was set in the start gate. If the gate happened to time out before
// reading it (cold boot), re-assert it now in the running state — the SSR module is
// only evaluated on the first request, so a pending breakpoint still binds in time.
await waitFor(() => responses.has(bpRespId), 3000, "setBreakpointByUrl response");
if (!responses.has(bpRespId)) {
  console.log("  (start gate missed the config — re-setting breakpoint in running state)");
  sendTo(targetPid, "Debugger.enable");
  bpRespId = sendTo(targetPid, "Debugger.setBreakpointByUrl", { url: API_URL, lineNumber: BP_LINE0 });
  await waitFor(() => responses.has(bpRespId), 3000, "re-set breakpoint response");
}
const bpResp = responses.get(bpRespId);
assert(bpResp && bpResp.result && bpResp.result.breakpointId, "setBreakpointByUrl returned a breakpointId");
assert(
  bpResp && bpResp.result && bpResp.result.locations.length === 0,
  "breakpoint pending before the SSR module is evaluated (no script yet)",
);

// ── the acceptance: HTTP request -> pause at the ORIGINAL source line ─────────
const tReq = Date.now();
const r1 = await httpGet(h.kernel, PORT, "/api");
const reqMs = Date.now() - tReq;
await waitFor(() => responses.has(localEvalId) && responses.has(totalEvalId), 5000, "evaluate responses");

assert(pausedEvents.length >= 2, "paused at least twice: breakpoint + stepOver (got " + pausedEvents.length + ")");
const p1 = pausedEvents[0];
const p2 = pausedEvents[1];
if (p1) {
  const f = p1.params.callFrames[0];
  console.log("\n  ── key paused event fields (breakpoint pause, in-VM) ──");
  console.log("  reason=" + p1.params.reason + " hitBreakpoints=" + JSON.stringify(p1.params.hitBreakpoints));
  console.log("  callFrames[0].url=" + f.url);
  console.log("  callFrames[0].functionName=" + f.functionName);
  console.log("  callFrames[0].location=" + JSON.stringify(f.location));
  console.log("  callFrames[0].callFrameId=" + f.callFrameId);
  assert(p1.params.reason === "breakpoint", "pause #1 reason is breakpoint");
  assert(f.url === API_URL, "paused frame url is the ORIGINAL .ts source URL (" + API_URL + ")");
  assert(f.location.lineNumber === BP_LINE0, "paused at ORIGINAL source line " + (BP_LINE0 + 1) + " (remap working in-VM)");
  assert(f.functionName === "handler", "pause #1 top frame is handler()");
}
if (p2) {
  const f = p2.params.callFrames[0];
  console.log("  step pause location=" + JSON.stringify(f.location) + " reason=" + p2.params.reason);
  assert(p2.params.reason === "step", "pause #2 reason is step");
  assert(f.location.lineNumber === BP_LINE0 + 1, "stepOver landed on the next ORIGINAL source line " + (BP_LINE0 + 2));
}
const localResp = responses.get(localEvalId);
const totalResp = responses.get(totalEvalId);
assert(localResp && localResp.result && localResp.result.result && localResp.result.result.value === 42,
  "evaluateOnCallFrame('local') === 42 in the paused SSR frame");
assert(totalResp && totalResp.result && totalResp.result.result && totalResp.result.result.value === 43,
  "evaluateOnCallFrame('total') === 43 after stepOver");
assert(r1.status === 200, "HTTP /api completed with 200 after resume (got " + r1.status + ")");
assert(/43/.test(r1.body), "HTTP response body carries the expected answer 43 (got " + r1.body + ")");
console.log("  response body: " + r1.body);

// The SSR module + its dep registered through the seam; node_modules did not.
assert(scriptParsedUrls.includes(API_URL), "SSR api.ts registered via scriptParsed through the seam");
assert(scriptParsedUrls.includes(DEP_URL), "SSR dep.ts registered via scriptParsed too");
assert(!scriptParsedUrls.some((u) => u.includes("/node_modules/")), "no scriptParsed for any node_modules file");
assert(
  resolvedBps.some((b) => b.location.lineNumber === BP_LINE0),
  "breakpointResolved at the ORIGINAL source line on the SSR script",
);

// A breakpoint attempt inside node_modules must not bind (no such script registered).
const nmBpId = sendTo(targetPid, "Debugger.setBreakpointByUrl", {
  url: "file://" + DIR + "/node_modules/vite/dist/node/chunks/node.js",
  lineNumber: 0,
});
await waitFor(() => responses.has(nmBpId), 3000, "node_modules breakpoint response");
const nmResp = responses.get(nmBpId);
assert(nmResp && nmResp.result && nmResp.result.locations.length === 0,
  "breakpoint in a node_modules file does not bind (excluded)");

// ── a second request after resume still serves (module cached, no re-pause) ───
const bpId = bpResp && bpResp.result && bpResp.result.breakpointId;
if (bpId) {
  const rmId = sendTo(targetPid, "Debugger.removeBreakpoint", { breakpointId: bpId });
  // Wait for the removal to be APPLIED before the next request: removeBreakpoint
  // is drained asynchronously by the running worker, and the breakpoint sits
  // inside handler() (re-invoked on EVERY request, not just at module eval), so
  // an un-awaited removal races the second request into a re-pause.
  await waitFor(() => responses.has(rmId), 3000, "removeBreakpoint response");
}
const pausesBefore = pausedEvents.length;
const r2 = await httpGet(h.kernel, PORT, "/api");
assert(r2.status === 200 && /43/.test(r2.body), "second /api request still serves 43 after resume");
assert(pausedEvents.length === pausesBefore, "second request did not re-pause (module cached, breakpoint removed)");

// ── control: a fresh server boot WITHOUT VV_DEBUG (zero-cost-when-off, in-VM) ──
// Same kernel, node_modules reused: stop the debug server, release its port, and
// boot a new server process with no VV_DEBUG. The seam installs per-process at
// attach, so this proves the off path pays nothing and serves normally.
h.kernel.stop(targetPid);
h.listening.delete(PORT);
const controlTargets = [];
h.kernel.onDebugTarget = (pid, added, info) => {
  if (added) controlTargets.push({ pid, command: info.command });
};
h.kernel.onDebugEvent = () => {};
const tCtrl = Date.now();
const boundCtrl = await waitListen(h, { dir: DIR, port: PORT, argv: ["server.mjs"], env: defaultEnv(DIR) });
assert(boundCtrl, "control server bound its port without VV_DEBUG");
assert(controlTargets.length === 0, "control: zero debug targets announced without VV_DEBUG");
const rc = await httpGet(h.kernel, PORT, "/api");
assert(rc.status === 200 && /43/.test(rc.body), "control /api serves normally without the debugger (got " + rc.status + " " + rc.body + ")");
const ctrlMs = Date.now() - tCtrl;
h.kernel.stop([...h.kernel.procs.keys()].find((p) => h.kernel.procs.get(p).command === "node") || -1);

// ── verdict ───────────────────────────────────────────────────────────────────
console.log("\n  timings: install=" + (installMs / 1000).toFixed(1) + "s  serve(bind)=" + (serveMs / 1000).toFixed(1) +
  "s  first-request(pause+eval+resume)=" + (reqMs / 1000).toFixed(1) + "s  control-boot=" + (ctrlMs / 1000).toFixed(1) + "s");
console.log("");
if (failures) {
  console.error("spike-debugger-ssr: " + failures + " assertion(s) FAILED");
  process.exit(1);
} else {
  console.log("spike-debugger-ssr: all assertions passed (in-VM SSR eval seam acceptance)");
  process.exit(0);
}
