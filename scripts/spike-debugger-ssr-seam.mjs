// Headless proof for the SSR eval seam (offline tier — no network, no kernel, no Wasm).
//
// The breakpoint debugger instruments guest code in the require loader, but Vite's
// SSR ModuleRunner evaluates modules with `new AsyncFunction(...)` — a constructor
// captured from %AsyncFunction.prototype% AT IMPORT TIME — so SSR/backend sources
// never passed the loader and their breakpoints never bound. This spike drives that
// eval path against a fake fetchModule transport, with the seam installed on a
// createDebugger instance, and proves:
//
//   breakpoint on the ORIGINAL TS line → breakpointResolved at that source line →
//   Debugger.paused at that source line → evaluateOnCallFrame in the paused scope →
//   stepOver onto the next source line → resume → correct exports;
//   plus HMR re-eval rebinding through the new map, the exclusion filters, self-heal,
//   honest no-map registration, the sync (vm.compileFunction-shaped) half, and an
//   empirical round-trip pin of the AsyncFunction wrapper padding offset P.
//
// TWO MODES, one set of seam assertions:
//   - vite installed (dev machines): the REAL ssrTransform + REAL ModuleRunner +
//     REAL ESModulesEvaluator from node_modules — the preferred proof, including
//     capture-at-import-time and the evaluator's own startOffset measurement.
//   - bare checkout (the Wasm-free CI gates run without node_modules): a
//     representative hand-built SSR-shaped body + pre-shifted inline map, evaluated
//     by an exact replica of ESModulesEvaluator.runInlinedModule's construction.
//     The seam under test is OUR code; both modes exercise it fully. The mode is
//     printed loudly so a green run is never ambiguous about what drove it.
//
// Run: node scripts/spike-debugger-ssr-seam.mjs

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createRequire } from "node:module";
import { createDebugger } from "../packages/runtime/debugger.js";
import { createLineMapper, decodeBase64Utf8, decodeMappings, decodeVlq } from "../packages/runtime/sourcemap.js";
import { transpileTypeScript } from "../packages/runtime/typescript-transform.js";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

let failures = 0;
function assert(cond, msg) {
  if (cond) console.log("  ok  " + msg);
  else {
    failures++;
    console.error(" FAIL " + msg);
  }
}

// ── transport: events collected; commands pulled from a scripted queue ────────
// Same shape as spike-debugger.mjs: a drained queue auto-resumes so the guest
// never wedges (mirrors the runtime's fail-open behaviour).
const events = [];
const responses = new Map(); // id -> {id,result} | {id,error}
let cmdQueue = [];
let cmdSeq = 0;
const dbg = createDebugger({
  send: (msg) => {
    if (msg.method) events.push(msg);
    else if (msg.id != null) responses.set(msg.id, msg);
  },
  waitForCommand: () => cmdQueue.shift() || { id: ++cmdSeq, method: "Debugger.resume", params: {} },
});
globalThis.__vvdbg = dbg.__vvdbg;
const clearEvents = () => (events.length = 0);
const cmd = (method, params) => {
  const id = ++cmdSeq;
  dbg.onCommand({ id, method, params: params || {} });
  return id;
};
const queue = (method, params) => {
  const id = ++cmdSeq;
  cmdQueue.push({ id, method, params: params || {} });
  return id;
};
const parsedFor = (url) => events.filter((e) => e.method === "Debugger.scriptParsed" && e.params.url === url);
const pauses = () => events.filter((e) => e.method === "Debugger.paused");

// ── 0. zero cost before attach: nothing patches by mere existence ─────────────
const NativeAsyncFunction = Object.getPrototypeOf(async function () {}).constructor;
const nativeSample = new NativeAsyncFunction("a", "b", "/*code*/").toString();
const nativeP = nativeSample.slice(0, nativeSample.indexOf("/*code*/")).split("\n").length - 1;
createDebugger({}); // a second instance must not patch anything by creation alone
assert(
  Object.getPrototypeOf(async function () {}).constructor === NativeAsyncFunction,
  "createDebugger alone does not patch the AsyncFunction constructor (no seam without attach)",
);

// ── 1. install the seam (what index.js's debug attach block does) ─────────────
const P = dbg.installEvalSeam();
assert(P === nativeP, `measured wrapper padding P=${P} matches the native measurement (${nativeP})`);
const Ctor = Object.getPrototypeOf(async function () {}).constructor;
assert(Ctor !== NativeAsyncFunction, "seam patched %AsyncFunction.prototype%.constructor (what Vite captures at import)");
assert(
  new Ctor("a", "b", "/*code*/").toString() === nativeSample,
  "bodies without a project sourceURL stay native-shaped — Vite's own padding probe is unaffected",
);
const plainFn = new Ctor("return 1");
assert(plainFn instanceof NativeAsyncFunction, "prototype identity preserved (instanceof intrinsic AsyncFunction)");
assert((await plainFn()) === 1, "native-built async function still evaluates");
class SubAsync extends Ctor {}
const subFn = new SubAsync("return 2");
assert(subFn instanceof SubAsync && subFn instanceof NativeAsyncFunction, "new.target subclassing preserved (Reflect.construct pattern)");
assert((await subFn()) === 2, "subclass-built async function evaluates");
assert(dbg.installEvalSeam() === P, "installEvalSeam is idempotent");

// ── 2. the eval driver: REAL vite when installed, representative fallback else ─
// The real imports happen AFTER the patch on purpose: module-runner.js reads
// `async function(){}.constructor` when it loads, so the patch must precede it —
// exactly the runtime's order (debug attach before the entry compiles).
let viteMode = false;
let ModuleRunner, ESModulesEvaluator, ssrTransform;
try {
  const require = createRequire(import.meta.url);
  const viteDir = path.dirname(require.resolve("vite/package.json"));
  // ssrTransform is not in vite's public export map; reach the internal chunk
  // that defines it (export alias B) through the installed package directory.
  ({ B: ssrTransform } = await import(pathToFileURL(path.join(viteDir, "dist/node/chunks/node.js")).href));
  ({ ModuleRunner, ESModulesEvaluator } = await import("vite/module-runner"));
  viteMode = typeof ssrTransform === "function";
} catch {
  viteMode = false;
}
console.log(
  viteMode
    ? "  mode: REAL vite (ssrTransform + ModuleRunner + ESModulesEvaluator from node_modules)"
    : "  mode: REPRESENTATIVE FALLBACK (bare checkout — hand-built SSR body + pre-shifted map, evaluator replica)",
);

// ── 3. fixtures: a TS server route + its dep ──────────────────────────────────
const SERVER_FILE = "/proj/src/server.ts";
const DEP_FILE = "/proj/src/dep.ts";
const SERVER_TS = `import { something } from "./dep"; // café ☕
export interface Opts { id: number }
export function handler(opts: Opts): number {
  const local = opts.id * 2 + something;
  const doubled = local + 1;
  return doubled;
}
export const answer = handler({ id: 21 });
`;
const DEP_TS = `// dependency module
export const something: number = 0;
`;

// Fallback-only: a minimal VLQ encoder (the independent oracle for our decoder)
// and a line-pair map builder. One column-0 segment per mapped generated line.
const B64 = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
function encodeVlq(value) {
  let v = value < 0 ? ((-value) << 1) | 1 : value << 1;
  let out = "";
  do {
    let d = v & 0x1f;
    v >>>= 5;
    if (v) d |= 0x20;
    out += B64[d];
  } while (v);
  return out;
}
function encodeLineMap(pairs, genLineCount) {
  const byLine = new Map(pairs);
  let prevSrc = 0;
  const lines = [];
  for (let g = 1; g <= genLineCount; g++) {
    const s = byLine.get(g);
    if (s == null) {
      lines.push("");
      continue;
    }
    lines.push(encodeVlq(0) + encodeVlq(0) + encodeVlq(s - 1 - prevSrc) + encodeVlq(0));
    prevSrc = s - 1;
  }
  return lines.join(";");
}
// Representative SSR-shaped transforms for the fixture family (a line-preserving
// variant of what ssrTransform emits: TLA import, exportName registration,
// function body). The HMR variant prepends one comment line, shifting the source
// side of the map by 1 — exactly what a real hot update does.
function fallbackTransform(ts, file) {
  const shift = ts.startsWith("// hot update\n") ? 1 : 0;
  if (file === DEP_FILE) {
    const code =
      "const something = 0;\n" +
      '__vite_ssr_exportName__("something", () => { try { return something } catch {} });\n';
    const pairs = [[1, 2], [2, 2]].map(([g, s]) => [g, s + shift]);
    return { code, map: { version: 3, sources: [path.basename(file)], sourcesContent: [ts], names: [], mappings: encodeLineMap(pairs, 2) } };
  }
  const code =
    'const __vite_ssr_import_0__ = await __vite_ssr_import__("./dep");\n' +
    "\n" +
    "function handler(opts) {\n" +
    "  const local = opts.id * 2 + __vite_ssr_import_0__.something;\n" +
    "  const doubled = local + 1;\n" +
    "  return doubled;\n" +
    "}\n" +
    "const answer = handler({ id: 21 });\n" +
    '__vite_ssr_exportName__("answer", () => { try { return answer } catch {} });\n';
  const pairs = [[1, 1], [3, 3], [4, 4], [5, 5], [6, 6], [7, 7], [8, 8], [9, 8]].map(([g, s]) => [g, s + shift]);
  return { code, map: { version: 3, sources: [path.basename(file)], sourcesContent: [ts], names: [], mappings: encodeLineMap(pairs, 9) } };
}
async function transformModule(ts, file) {
  if (viteMode) {
    // The runtime's own line-preserving TS strip stands in for vite's oxc pass;
    // ssrTransform then does the real SSR rewrite and chains the original source
    // into the map's sourcesContent.
    const js = transpileTypeScript(ts, file, {});
    return await ssrTransform(js, null, file, ts);
  }
  return fallbackTransform(ts, file);
}
// The server-side append, replicated from vite's fetchModule → inlineSourceMap:
// the map's mappings are PRE-SHIFTED by startOffset (= P + 1: wrapper padding +
// the '"use strict";' line the evaluator prepends) into function-source
// coordinates, then base64-inlined after the sourceURL.
function serverCodeFor(result, id, startOffset) {
  const shifted = { ...result.map, mappings: ";".repeat(startOffset) + result.map.mappings };
  const b64 = Buffer.from(JSON.stringify(shifted)).toString("base64");
  const code =
    result.code.trimEnd() +
    `\n//# sourceURL=${id}\n//# sourceMappingSource=vite-generated\n//# sourceMappingURL=data:application/json;base64,${b64}\n`;
  return { code, shifted };
}
let serverResult = await transformModule(SERVER_TS, SERVER_FILE);
const firstServerResult = serverResult;
const depResult = await transformModule(DEP_TS, DEP_FILE);
const modules = new Map([
  [SERVER_FILE, { file: SERVER_FILE, result: serverResult }],
  ["./dep", { file: DEP_FILE, result: depResult }],
]);
const seenStartOffsets = [];

// The driver: fetch + evaluate one module (and its deps) the way the runner does.
let importModule, clearRunnerCache, evaluatorStartOffset;
if (viteMode) {
  // The raw invoke contract (createInvokeableTransport): a wrapped vite:invoke
  // payload in, { result } | { error } out.
  const transport = {
    invoke: async (payload) => {
      const { name, data: args } = payload.data;
      if (name === "getBuiltins") return { result: [] };
      if (name === "fetchModule") {
        const [url, , options] = args;
        const mod = modules.get(url);
        if (!mod) throw new Error("unexpected fetchModule: " + url);
        seenStartOffsets.push(options.startOffset);
        const { code } = serverCodeFor(mod.result, mod.file, options.startOffset);
        return { result: { code, file: mod.file, id: mod.file, url, invalidate: false } };
      }
      throw new Error("unexpected transport invoke: " + name);
    },
  };
  const evaluator = new ESModulesEvaluator();
  evaluatorStartOffset = evaluator.startOffset;
  const runner = new ModuleRunner({ transport, hmr: false, sourcemapInterceptor: false }, evaluator);
  importModule = (url) => runner.import(url);
  clearRunnerCache = () => runner.clearCache();
} else {
  // Exact replica of ESModulesEvaluator (module-runner.js): the constructor is
  // captured from the intrinsic prototype (post-patch, as Vite captures it at
  // import time), the padding is measured with Vite's own probe trick, and the
  // body is built as new AsyncFunction(6 ssr keys, '"use strict";\n' + code).
  const SSR_KEYS = [
    "__vite_ssr_exports__",
    "__vite_ssr_import_meta__",
    "__vite_ssr_import__",
    "__vite_ssr_dynamic_import__",
    "__vite_ssr_exportAll__",
    "__vite_ssr_exportName__",
  ];
  const AsyncFunctionCaptured = Object.getPrototypeOf(async function () {}).constructor;
  const marker = "/*code*/";
  const sample = new AsyncFunctionCaptured("a", "b", marker).toString();
  const padding = sample.slice(0, sample.indexOf(marker)).split("\n").length - 1;
  evaluatorStartOffset = padding + 1;
  async function runInlinedModule(context, code) {
    await new AsyncFunctionCaptured(...SSR_KEYS, '"use strict";\n' + code)(...SSR_KEYS.map((k) => context[k]));
    Object.seal(context.__vite_ssr_exports__);
  }
  async function fallbackImport(url) {
    const mod = modules.get(url);
    if (!mod) throw new Error("unexpected import: " + url);
    seenStartOffsets.push(evaluatorStartOffset);
    const { code } = serverCodeFor(mod.result, mod.file, evaluatorStartOffset);
    const exports = Object.create(null);
    const context = {
      __vite_ssr_exports__: exports,
      __vite_ssr_import_meta__: { url: "file://" + mod.file },
      __vite_ssr_import__: (dep) => fallbackImport(dep),
      __vite_ssr_dynamic_import__: (dep) => fallbackImport(dep),
      __vite_ssr_exportAll__: (obj) => Object.assign(exports, obj),
      __vite_ssr_exportName__: (name, getter) =>
        Object.defineProperty(exports, name, { enumerable: true, configurable: true, get: getter }),
    };
    await runInlinedModule(context, code);
    return exports;
  }
  importModule = fallbackImport;
  clearRunnerCache = () => {}; // the replica keeps no module cache: every import re-evals
}
assert(
  evaluatorStartOffset === P + 1,
  `the ${viteMode ? "REAL" : "replica"} evaluator measured startOffset P+1=${evaluatorStartOffset} through the patched constructor`,
);

// ── 4. breakpoint on the ORIGINAL TS line, set before the module exists ───────
cmd("Runtime.enable");
cmd("Debugger.enable");
// Original line 5: `const doubled = local + 1;` (0-based 4) — `local` is live there.
const BP_LINE0 = 4;
const bpId = cmd("Debugger.setBreakpointByUrl", { url: "file://" + SERVER_FILE, lineNumber: BP_LINE0 });
assert(responses.get(bpId).result.locations.length === 0, "breakpoint pending before the SSR module is evaluated");
const evalLocalId = queue("Debugger.evaluateOnCallFrame", { callFrameId: "cf:0", expression: "local" });
const evalOptsId = queue("Debugger.evaluateOnCallFrame", { callFrameId: "cf:0", expression: "opts.id" });
queue("Debugger.stepOver");
const evalDoubledId = queue("Debugger.evaluateOnCallFrame", { callFrameId: "cf:0", expression: "doubled" });
queue("Debugger.resume");

const exports1 = await importModule(SERVER_FILE);
assert(exports1.answer === 43, "SSR module evaluated to correct exports through the seam (answer === 43)");
assert(seenStartOffsets.length >= 2 && seenStartOffsets.every((o) => o === P + 1), "every fetch used startOffset P+1");
assert(parsedFor("file://" + SERVER_FILE).length === 1, "SSR server module registered via scriptParsed");
assert(parsedFor("file://" + DEP_FILE).length === 1, "SSR dep module registered via scriptParsed too");
const sid1 = Number(parsedFor("file://" + SERVER_FILE)[0].params.scriptId);
assert(parsedFor("file://" + SERVER_FILE)[0].params.isModule === true, "SSR script registered as a module");
const resolved1 = events.filter((e) => e.method === "Debugger.breakpointResolved");
assert(
  resolved1.length === 1 && resolved1[0].params.location.lineNumber === BP_LINE0 && Number(resolved1[0].params.location.scriptId) === sid1,
  "breakpointResolved at the ORIGINAL source line on the SSR script",
);
const pauses1 = pauses();
assert(pauses1.length === 2, "two pauses: breakpoint + stepOver");
assert(pauses1[0].params.reason === "breakpoint" && pauses1[0].params.hitBreakpoints.length === 1, "pause #1 is the breakpoint");
assert(pauses1[0].params.callFrames[0].functionName === "handler", "pause #1 top frame is handler()");
assert(pauses1[0].params.callFrames[0].location.lineNumber === BP_LINE0, `pause #1 at ORIGINAL line ${BP_LINE0 + 1}`);
assert(pauses1[0].params.callFrames[0].url === "file://" + SERVER_FILE, "paused frame url is the project file");
assert(responses.get(evalLocalId).result.result.value === 42, "evaluateOnCallFrame('local') === 42 in the SSR frame");
assert(responses.get(evalOptsId).result.result.value === 21, "evaluateOnCallFrame('opts.id') === 21 in the SSR frame");
assert(pauses1[1].params.reason === "step", "pause #2 reason is step");
assert(pauses1[1].params.callFrames[0].location.lineNumber === BP_LINE0 + 1, "stepOver landed on the next ORIGINAL source line");
assert(responses.get(evalDoubledId).result.result.value === 43, "evaluateOnCallFrame('doubled') === 43 after stepOver");
const srcId = cmd("Debugger.getScriptSource", { scriptId: String(sid1) });
assert(responses.get(srcId).result.scriptSource === SERVER_TS, "getScriptSource returns the ORIGINAL TS source");
const pbId = cmd("Debugger.getPossibleBreakpoints", { start: { scriptId: String(sid1), lineNumber: BP_LINE0 } });
assert(responses.get(pbId).result.locations[0].lineNumber === BP_LINE0, "getPossibleBreakpoints remaps query and result through the map");

// ── 5. HMR re-eval: a new body version must REBIND the existing breakpoint ────
const HOT_TS = "// hot update\n" + SERVER_TS;
serverResult = await transformModule(HOT_TS, SERVER_FILE);
modules.set(SERVER_FILE, { file: SERVER_FILE, result: serverResult });
clearRunnerCache();
clearEvents();
const hotEvalId = queue("Debugger.evaluateOnCallFrame", { callFrameId: "cf:0", expression: "opts.id" });
queue("Debugger.resume");
const exports2 = await importModule(SERVER_FILE);
assert(exports2.answer === 43, "re-evaluated SSR module still computes answer === 43");
assert(parsedFor("file://" + SERVER_FILE).length === 1, "re-eval registered exactly one new script");
const sid2 = Number(parsedFor("file://" + SERVER_FILE)[0].params.scriptId);
assert(sid2 !== sid1, "new body version got a fresh sid");
const resolved2 = events.filter((e) => e.method === "Debugger.breakpointResolved");
assert(
  resolved2.length === 1 && Number(resolved2[0].params.location.scriptId) === sid2 && resolved2[0].params.location.lineNumber === BP_LINE0,
  "existing breakpoint REBOUND to the new sid at its stored SOURCE line (through the new map)",
);
const pauses2 = pauses();
assert(pauses2.length === 1 && pauses2[0].params.callFrames[0].location.lineNumber === BP_LINE0, "re-eval paused at the same ORIGINAL source line");
assert(responses.get(hotEvalId).result.result.value === 21, "evaluate still works in the rebound frame");
const oldSrcId = cmd("Debugger.getScriptSource", { scriptId: String(sid1) });
assert(responses.get(oldSrcId).result.scriptSource === SERVER_TS, "old rec stays alive for in-flight frames (old source intact)");

// ── 6. exclusion filters, self-heal, cache, honest no-map registration ────────
clearEvents();
assert(dbg.instrumentEvaluated("const x = 1;\n//# sourceURL=/proj/node_modules/dep/index.js\n") === null, "node_modules sourceURL excluded");
assert(dbg.instrumentEvaluated("const x = 1;\n//# sourceURL=/@id/__x00__virtual:mod\n") === null, "virtual /@id/ module skipped");
assert(dbg.instrumentEvaluated("const x = 1;\n//# sourceURL=src/relative.js\n") === null, "non-absolute sourceURL skipped");
assert(dbg.instrumentEvaluated("const x = 1;") === null, "body without sourceURL builds natively");
assert(dbg.instrumentEvaluated("const = ;\n//# sourceURL=/proj/broken.js\n") === null, "self-heal: unparseable body returns null");
const qWoven = dbg.instrumentEvaluated("const x = 1;\n//# sourceURL=/proj/q.js?v=2\n");
assert(typeof qWoven === "string" && parsedFor("file:///proj/q.js").length === 1, "?query stripped from the module id before registration");
const notJsonB64 = Buffer.from("not json").toString("base64");
const badMapBody = `const x = 1;\n//# sourceURL=/proj/badmap.js\n//# sourceMappingURL=data:application/json;base64,${notJsonB64}\n`;
const badMapWoven = dbg.instrumentEvaluated(badMapBody);
assert(typeof badMapWoven === "string", "malformed inline map self-heals to an honest registration");
const badMapSid = Number(parsedFor("file:///proj/badmap.js")[0].params.scriptId);
const badMapSrcId = cmd("Debugger.getScriptSource", { scriptId: String(badMapSid) });
assert(responses.get(badMapSrcId).result.scriptSource === badMapBody, "undecodable map → source is the transformed body (no guessed remap)");

const plainBody = "const a = 1;\nconst b = a + 1;\nglobalThis.__plainResult = b;\n//# sourceURL=/proj/plain.js\n";
const plainWoven = dbg.instrumentEvaluated(plainBody);
assert(typeof plainWoven === "string" && plainWoven.includes("__vvdbg.line"), "no-map body instrumented");
assert(dbg.instrumentEvaluated(plainWoven) === null, "already-woven body is never woven twice");
const plainSid = Number(parsedFor("file:///proj/plain.js")[0].params.scriptId);
const plainSrcId = cmd("Debugger.getScriptSource", { scriptId: String(plainSid) });
assert(responses.get(plainSrcId).result.scriptSource === plainBody, "no-map script registered honestly (source = transformed body)");
const plainBpId = cmd("Debugger.setBreakpointByUrl", { url: "file:///proj/plain.js", lineNumber: 1 });
assert(responses.get(plainBpId).result.locations[0].lineNumber === 1, "no-map breakpoint binds in body coordinates (identity)");
const plainEvalId = queue("Debugger.evaluateOnCallFrame", { callFrameId: "cf:0", expression: "a" });
queue("Debugger.resume");
await new Ctor(plainBody)();
assert(globalThis.__plainResult === 2, "no-map body executed correctly through the seam");
const plainPauses = pauses();
assert(plainPauses.length === 1 && plainPauses[0].params.callFrames[0].location.lineNumber === 1, "no-map pause at body line 2 (no remap)");
assert(responses.get(plainEvalId).result.result.value === 1, "evaluate in the no-map frame");
assert(dbg.instrumentEvaluated(plainBody) === plainWoven, "identical re-eval reuses the cached woven body");
assert(parsedFor("file:///proj/plain.js").length === 1, "cache hit did not re-register the script");

// ── 7. the sync half: a vm.compileFunction-shaped body through the hook ───────
// vm.compileFunction appends `\n//# sourceURL=<filename>` and builds via
// globalThis.Function — index.js's OcFunction hook substitutes the woven body.
// Here the host Function is native, so executing the woven body directly is
// exactly what OcFunction does after a successful substitution.
const vmBody = "const p = 6;\nconst q = p * 7;\nglobalThis.__vmResult = q;\n//# sourceURL=/proj/vmcode.js";
const vmWoven = dbg.instrumentEvaluated(vmBody);
assert(typeof vmWoven === "string" && vmWoven !== vmBody, "vm.compileFunction-shaped body instrumented");
cmd("Debugger.setBreakpointByUrl", { url: "file:///proj/vmcode.js", lineNumber: 1 });
const vmEvalId = queue("Debugger.evaluateOnCallFrame", { callFrameId: "cf:0", expression: "p" });
queue("Debugger.resume");
new Function(vmWoven)();
assert(globalThis.__vmResult === 42, "sync-seam body executed correctly");
const vmPauses = pauses().filter((e) => e.params.callFrames[0].url === "file:///proj/vmcode.js");
assert(vmPauses.length === 1 && vmPauses[0].params.callFrames[0].location.lineNumber === 1, "sync-seam pause at body line 2");
assert(responses.get(vmEvalId).result.result.value === 6, "evaluate in the sync-seam frame");

// ── 8. empirical round-trip pin of the P offset (no hand-waving) ──────────────
// The unshifted transform map is the oracle: SSR line N ↔ original line S. The
// shifted (inline) map must agree at body line N+1 read at +P, and inversely. In
// fallback mode this also checks our VLQ decoder against the independent encoder.
const shiftedMap = { ...firstServerResult.map, mappings: ";".repeat(P + 1) + firstServerResult.map.mappings };
const shifted = createLineMapper(shiftedMap);
const unshifted = createLineMapper(firstServerResult.map);
const ssrLineCount = firstServerResult.code.split("\n").length;
let fwdChecked = 0;
let fwdBad = 0;
for (let n = 1; n <= ssrLineCount; n++) {
  const s = unshifted.toSource(n);
  if (s == null) continue;
  fwdChecked++;
  if (shifted.toSource(n + 1 + P) !== s) fwdBad++;
}
assert(fwdChecked > 0 && fwdBad === 0, `forward round-trip pinned on ${fwdChecked} mapped lines: bodyLine + P (P=${P})`);
let invChecked = 0;
let invBad = 0;
for (let s = 1; s <= SERVER_TS.split("\n").length; s++) {
  const g = unshifted.toGenerated(s);
  if (g == null) continue;
  invChecked++;
  if (shifted.toGenerated(s) !== g + P + 1) invBad++;
}
assert(invChecked > 0 && invBad === 0, `inverse round-trip pinned on ${invChecked} source lines: generated + P + 1`);
const mapJson = JSON.stringify(shiftedMap);
const mapB64 = Buffer.from(mapJson).toString("base64");
assert(decodeBase64Utf8(mapB64) === mapJson, "hand-rolled base64+UTF-8 decode matches Buffer (non-ASCII sourcesContent)");
const bigContent = "line café ☕\n".repeat(30000); // > 8192 code points: chunked decode
assert(decodeBase64Utf8(Buffer.from(bigContent).toString("base64")) === bigContent, "base64+UTF-8 decode handles large maps (chunked code points)");
assert(JSON.stringify(decodeMappings("AAAA;AACA")) === JSON.stringify([[[0, 0, 0, 0]], [[0, 0, 1, 0]]]), "VLQ mappings decode with deltas resolved");
assert(JSON.stringify(decodeVlq("nD")) === "[-51]", "VLQ signed multi-digit decode");

// ── 9. zero-cost gating pins on the index.js wiring ───────────────────────────
// createRuntime needs a kernel, so the attach gating is pinned statically: the
// seam install must sit INSIDE the debugEnabled gate, and the sync hook must be
// the same one-global-read pattern the loader uses.
const indexSrc = fs.readFileSync(path.join(ROOT, "packages/runtime/index.js"), "utf8");
const gate = indexSrc.indexOf("if (debugEnabled && !__dbg)");
const install = indexSrc.indexOf("__dbg.installEvalSeam()");
const gateEnd = indexSrc.indexOf("let exitEmitted", gate);
assert(gate !== -1 && install > gate && install < gateEnd, "installEvalSeam() sits inside the debugEnabled attach gate (zero cost when VV_DEBUG unset)");
assert(indexSrc.includes("const dh = globalThis.__vvDebugHook;"), "OcFunction's sync hook is one global read of __vvDebugHook");

// ── cleanup: restore the intrinsic constructor ────────────────────────────────
Object.getPrototypeOf(async function () {}).constructor = NativeAsyncFunction;
assert((await new NativeAsyncFunction("return 1")()) === 1, "native AsyncFunction restored and working");

console.log("");
if (failures) {
  console.error(`spike-debugger-ssr-seam: ${failures} assertion(s) FAILED`);
  process.exit(1);
} else {
  console.log(`spike-debugger-ssr-seam: all assertions passed (${viteMode ? "real vite" : "representative fallback"} mode)`);
}
