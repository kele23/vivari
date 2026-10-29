// Spike (OFFLINE, fast): guard the toolchain-generalization subsystem so a silent
// regression (esbuild-wasm version drift, or a broken native->wasm alias table)
// is caught in CI instead of surfacing as a mysterious in-browser build hang.
//
// Gates (all must pass):
//   1. NATIVE_WASM_ALIASES contains the expected native->wasm drop-ins.
//   2. The in-process esbuild patch APPLIES to the known esbuild-wasm@0.28.1
//      spawn block (produces the OC marker + the in-thread Go service).
//   3. It is VERSION-AGNOSTIC: the same block shape with a different version
//      literal still patches, threading that version into --service.
//   4. It is a strict no-op for a genuine NATIVE esbuild install (no wasm assets).
//   5. On block-shape DRIFT it warns loudly and returns null (fail loud, not silent).
//   6. NATIVE_DROPIN_ALIASES + synthesizeRemappedPackument version-remap a
//      non-lockstep drop-in (bcrypt -> bcryptjs) correctly.
//
//   run:  node scripts/spike-toolchain.mjs

import path from "node:path";
import { maybePatchEsbuildInProcess } from "../packages/runtime/esbuild-inproc-patch.js";
import {
  NATIVE_WASM_ALIASES,
  NATIVE_DROPIN_ALIASES,
  PNPM_STORE_ALIAS_MARKER,
  maybePatchPnpmStoreAliases,
  synthesizeRemappedPackument,
} from "../packages/runtime/toolchain-shims.js";
import {
  ARBORIST_BUILD_IDEAL_TREE,
  patchArboristPeerSet,
  stubNodeGyp,
} from "../packages/kernel-host/node-gyp-stub.js";

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? "  ok   " : "  FAIL ") + msg);
  if (!cond) failures++;
};

// The exact child-spawn block esbuild-wasm ships in lib/main.js (0.28.1). The
// %VER% below is filled per-test to synthesize different releases.
const SPAWN_BLOCK = (ver) => `  let [command, args] = esbuildCommandAndArgs();
  let child = child_process.spawn(command, args.concat(\`--service=\${"${ver}"}\`, "--ping"), {
    windowsHide: true,
    stdio: ["pipe", "pipe", "inherit"],
    cwd: defaultWD
  });
  let { readFromStdout, afterClose, service } = createChannel({
    writeToStdin(bytes) {
      child.stdin.write(bytes, (err) => {
        if (err) afterClose(err);
      });
    },
    readFileSync: fs2.readFileSync,
    isSync: false,
    hasFS: true,
    esbuild: node_exports
  });
  child.stdin.on("error", afterClose);
  child.on("error", afterClose);
  const stdin = child.stdin;
  const stdout = child.stdout;
  stdout.on("data", readFromStdout);
  stdout.on("end", afterClose);
  stopService = () => {
    stdin.destroy();
    stdout.destroy();
    child.kill();
    initializeWasCalled = false;
    longLivedService = void 0;
    stopService = void 0;
  };
  let refCount = 0;
  child.unref();
  if (stdin.unref) {
    stdin.unref();
  }
  if (stdout.unref) {
    stdout.unref();
  }
  const refs = {
    ref() {
      if (++refCount === 1) child.ref();
    },
    unref() {
      if (--refCount === 0) child.unref();
    }
  };`;

const wrap = (block) => `"use strict";\nfunction ensureServiceIsRunning() {\n${block}\n  return service;\n}\n`;

// A mock fs whose existsSync answers per a set of "present" paths.
const mockFs = (present) => ({ existsSync: (p) => present.has(p) });
const MAIN = "/app/node_modules/esbuild/lib/main.js";
const PKG = "/app/node_modules/esbuild"; // where esbuild.wasm + wasm_exec.js live
const wasmPresent = mockFs(new Set([path.join(PKG, "esbuild.wasm"), path.join(PKG, "wasm_exec.js")]));
const noWasm = mockFs(new Set());

// --- 1. alias table -----------------------------------------------------------
ok(NATIVE_WASM_ALIASES.esbuild === "esbuild-wasm", "alias esbuild -> esbuild-wasm");
ok(NATIVE_WASM_ALIASES.rollup === "@rollup/wasm-node", "alias rollup -> @rollup/wasm-node");
ok(NATIVE_WASM_ALIASES.lightningcss === "lightningcss-wasm", "alias lightningcss -> lightningcss-wasm");

// --- 2. patch applies to the known block --------------------------------------
const patched = maybePatchEsbuildInProcess(wrap(SPAWN_BLOCK("0.28.1")), MAIN, wasmPresent, path);
ok(patched != null, "patch returns a rewritten source for esbuild-wasm@0.28.1");
ok(patched != null && patched.includes("[Vivari] in-process esbuild service"), "rewrite carries the OC marker");
ok(patched != null && !patched.includes('child_process.spawn(command'), "child spawn removed");
ok(patched != null && patched.includes('--service=${"0.28.1"}'), "version 0.28.1 threaded into --service");

// idempotent: patching the patched source again is a no-op
ok(maybePatchEsbuildInProcess(patched, MAIN, wasmPresent, path) === null, "already-patched source is a no-op");

// --- 3. version-agnostic ------------------------------------------------------
const patched2 = maybePatchEsbuildInProcess(wrap(SPAWN_BLOCK("0.29.7")), MAIN, wasmPresent, path);
ok(patched2 != null, "patch applies to a different version (0.29.7) with same block shape");
ok(patched2 != null && patched2.includes('--service=${"0.29.7"}'), "captured version 0.29.7 threaded into --service");

// --- 4. native esbuild left untouched ----------------------------------------
ok(
  maybePatchEsbuildInProcess(wrap(SPAWN_BLOCK("0.28.1")), MAIN, noWasm, path) === null,
  "native esbuild (no wasm assets) left untouched",
);

// --- 5. drift warns loudly and returns null -----------------------------------
const drifted = wrap(SPAWN_BLOCK("0.28.1").replace("child_process.spawn(command", "child_process.fork(command"));
let warned = false;
const origWarn = console.warn;
console.warn = (...a) => {
  if (String(a[0]).includes("in-process patch did NOT apply")) warned = true;
};
const driftResult = maybePatchEsbuildInProcess(drifted, MAIN, wasmPresent, path);
console.warn = origWarn;
ok(driftResult === null, "drifted block returns null (no silent patch)");
ok(warned, "drifted block warns loudly");

// --- 6. non-lockstep drop-in: version-remapped packument ----------------------
ok(NATIVE_DROPIN_ALIASES.bcrypt === "bcryptjs", "drop-in alias bcrypt -> bcryptjs");

// Mock the two real packuments: a native `bcrypt` (node-pre-gyp, native deps,
// install scripts, cpu/os gating) and a pure-JS `bcryptjs` (zero deps).
const bcryptPack = {
  name: "bcrypt",
  _id: "bcrypt",
  "dist-tags": { latest: "6.0.0" },
  versions: {
    "5.1.1": {
      name: "bcrypt",
      version: "5.1.1",
      dist: { tarball: "https://reg/bcrypt/-/bcrypt-5.1.1.tgz" },
      dependencies: { "@mapbox/node-pre-gyp": "^1.0.11", "node-addon-api": "^5.0.0" },
      optionalDependencies: {},
      scripts: { install: "node-pre-gyp install --fallback-to-build" },
      cpu: ["x64", "arm64"],
      os: ["linux", "darwin", "win32"],
    },
    "6.0.0": {
      name: "bcrypt",
      version: "6.0.0",
      dist: { tarball: "https://reg/bcrypt/-/bcrypt-6.0.0.tgz" },
      dependencies: { "@mapbox/node-pre-gyp": "^2.0.0", "node-addon-api": "^8.3.0" },
      scripts: { install: "node-pre-gyp install --fallback-to-build" },
    },
  },
};
const bcryptjsPack = {
  name: "bcryptjs",
  _id: "bcryptjs",
  "dist-tags": { latest: "3.0.3" },
  versions: {
    "3.0.3": {
      name: "bcryptjs",
      version: "3.0.3",
      dist: { tarball: "https://reg/bcryptjs/-/bcryptjs-3.0.3.tgz" },
      dependencies: {},
      main: "index.js",
      type: "module",
    },
  },
};

const synth = synthesizeRemappedPackument(bcryptPack, bcryptjsPack, "bcrypt");
ok(synth != null, "remap: synthesizes a packument");
ok(synth != null && synth.name === "bcrypt", "remap: served under the source name (bcrypt)");
ok(synth != null && synth["dist-tags"].latest === "6.0.0", "remap: keeps the SOURCE dist-tags");
const vkeys = synth ? Object.keys(synth.versions) : [];
ok(vkeys.includes("5.1.1") && vkeys.includes("6.0.0"), "remap: mirrors SOURCE versions (so any bcrypt@<range> resolves)");
const v6 = synth && synth.versions["6.0.0"];
ok(!!v6 && v6.dist.tarball === "https://reg/bcryptjs/-/bcryptjs-3.0.3.tgz", "remap: a source version points at the TARGET (bcryptjs) tarball");
ok(!!v6 && JSON.stringify(v6.dependencies) === "{}", "remap: deps come from the target (no native @mapbox/node-pre-gyp)");
ok(!!v6 && !("scripts" in v6) && !("optionalDependencies" in v6) && !("cpu" in v6) && !("os" in v6),
  "remap: native-install metadata (scripts/optionalDependencies/cpu/os) stripped");
ok(!!v6 && v6.main === "index.js" && v6.type === "module", "remap: carries the target's main/type");

// Guard: unusable inputs yield null (fetcher then falls back to the plain fetch).
ok(synthesizeRemappedPackument(null, bcryptjsPack, "bcrypt") === null, "remap: null source -> null");
ok(synthesizeRemappedPackument(bcryptPack, { name: "bcryptjs" }, "bcrypt") === null, "remap: target without versions -> null");

// --- 7. @npmcli/arborist #loadPeerSet detach guard ---------------------------
const ARBORIST_SNIPPET = `class BuildIdealTree {
  constructor(visit) { this.visit = visit }
  #failPeerConflict() {}
  run(node) { return this.#loadPeerSet(node, new Set()) }
  async #loadPeerSet (node, required) {
    const peerEdges = [...node.edgesOut.values()]
    for (const edge of peerEdges) {
      const parentEdge = node.parent.edgesOut.get(edge.name)
      await this.visit(edge, parentEdge)
      // ok, it's the root, or we're in unforced strict mode, so this is bad
      this.#failPeerConflict(edge, parentEdge)
    }
    return node
  }
}`;

const patchedArborist = patchArboristPeerSet(ARBORIST_SNIPPET);
ok(patchedArborist != null, "arborist: patchArboristPeerSet rewrites #loadPeerSet");
ok(
  patchArboristPeerSet(ARBORIST_SNIPPET.replace(/\n/g, "\r\n")) === patchedArborist,
  "arborist: CRLF source normalizes and patches identically",
);

let arboristWarned = false;
const origArboristWarn = console.warn;
console.warn = (...a) => {
  if (String(a[0]).includes("#loadPeerSet patch did NOT apply")) arboristWarned = true;
};
ok(patchArboristPeerSet(patchedArborist) === null, "arborist: already-patched source is a no-op");
ok(!arboristWarned, "arborist: already-patched source does not warn");
ok(patchArboristPeerSet("class Other {}") === null, "arborist: drifted/unrelated source returns null");
ok(arboristWarned, "arborist: drifted/unrelated source warns loudly");
console.warn = origArboristWarn;

// Simulate a recursive #loadPeerSet call detaching `node` on the first edge
// and replacing it in `peerSet` before the second edge is visited.
const PeerSetHarness = new Function(`${patchedArborist}; return BuildIdealTree;`)();
const peerSetRoot = {
  edgesOut: new Map([["@vitest/browser-webdriverio", {}], ["@vitest/coverage-istanbul", {}]]),
  children: new Map(),
};
const initialNode = {
  name: "vitest",
  version: "4.1.12",
  parent: peerSetRoot,
  edgesOut: new Map([
    ["@vitest/browser-webdriverio", { name: "@vitest/browser-webdriverio" }],
    ["@vitest/coverage-istanbul", { name: "@vitest/coverage-istanbul" }],
  ]),
};
const replacementNode = { name: "vitest", version: "4.1.11", parent: peerSetRoot };
peerSetRoot.children.set("vitest", initialNode);

const visited = [];
const settled = await new PeerSetHarness((edge) => {
  visited.push(edge.name);
  if (edge.name === "@vitest/browser-webdriverio") {
    // Recursive peer resolution replaces vitest@4.1.12 with vitest@4.1.11 in peerSetRoot.
    initialNode.parent = null;
    peerSetRoot.children.set("vitest", replacementNode);
  }
}).run(initialNode);

ok(settled === replacementNode, "arborist: detached peer node settles to its replacement in peerSet");
ok(visited.length === 1 && visited[0] === "@vitest/browser-webdriverio", "arborist: stops iterating stale peer edges once detached");

// Check that stubNodeGyp applies the patch in a mock VFS kernel.
const vfsMap = new Map([["/npm" + ARBORIST_BUILD_IDEAL_TREE, ARBORIST_SNIPPET]]);
const mockKernel = {
  exists: (p) => vfsMap.has(p),
  readFile: (p) => vfsMap.get(p),
  writeFile: (p, c) => vfsMap.set(p, c),
};
stubNodeGyp(mockKernel, "/npm");
ok(
  vfsMap.get("/npm" + ARBORIST_BUILD_IDEAL_TREE) === patchedArborist,
  "arborist: stubNodeGyp patches build-ideal-tree.js in the VFS",
);

// --- 8. pnpm store-alias remap (maybePatchPnpmStoreAliases) ------------------
const PNPM_SNIPPET = `// pnpm packageRequester fixture
    function fetchToStore(ctx, opts) {
      if (!opts.pkg.name) {
        opts.fetchRawManifest = true;
      }
      if (opts.fetchRawManifest && !result2.fetchRawManifest) {
        result2.fetching = removeKeyOnFail(result2.fetching.then(async ({ files }) => {
          if (files.unprocessed) {
            return {
              files,
              bundledManifest: await readBundledManifest(manifestPath)
            };
          }
          return {
            files,
            bundledManifest: await readBundledManifest(files.filesIndex["package.json"])
          };
        }));
      }
      const getLazyFetching = () => result2.fetching;
      async function doFetchToStore(filesIndexFile, fetching, target) {
        try {
          if (!opts.force) {
            const { verified, pkgFilesIndex, manifest, requiresBuild } = await ctx.readPkgFromCafs(filesIndexFile, opts.fetchRawManifest);
            if (verified) {
              if (pkgFilesIndex.name != null && opts.expectedPkg?.name != null && pkgFilesIndex.name.toLowerCase() !== opts.expectedPkg.name.toLowerCase() || pkgFilesIndex.version != null && opts.expectedPkg?.version != null && pkgFilesIndex.version !== opts.expectedPkg.version) {
                if (ctx.strictStorePkgContentCheck ?? true) {
                  const err = new Error("Package name mismatch");
                  err.code = "ERR_PNPM_UNEXPECTED_PKG_CONTENT_IN_STORE";
                  throw err;
                }
                ctx.onWarn("Package name mismatch");
              }
              fetching.resolve({
                files: { resolvedFrom: "store" },
                bundledManifest: manifest == null ? manifest : normalizeBundledManifest(manifest)
              });
              return;
            }
          }
          const fetchedPackage = await ctx.fetch();
          fetching.resolve({
            files: { resolvedFrom: "remote" },
            bundledManifest: fetchedPackage.manifest == null ? fetchedPackage.manifest : normalizeBundledManifest(fetchedPackage.manifest)
          });
        } catch (err) {
          fetching.reject(err);
        }
      }
      return { doFetchToStore };
    }
    async function getTopParents(pkgAliases, modulesDir) {
      const pkgs = await Promise.all(pkgAliases.map((alias) => path_1.default.join(modulesDir, alias)).map(read_package_json_1.safeReadPackageJsonFromDir));
      return (0, zipWith_1.default)((manifest, alias) => {
        if (!manifest)
          return null;
        return {
          alias,
          name: manifest.name,
          version: manifest.version
        };
      }, pkgs, pkgAliases).filter(Boolean);
    }
`;

const PNPM_FILE = "/usr/lib/node_modules/pnpm/dist/pnpm.cjs";
const patchedPnpm = maybePatchPnpmStoreAliases(PNPM_SNIPPET, PNPM_FILE);
ok(patchedPnpm != null, "pnpm-alias: maybePatchPnpmStoreAliases rewrites pnpm.cjs");
ok(patchedPnpm != null && patchedPnpm.includes(PNPM_STORE_ALIAS_MARKER), "pnpm-alias: rewrite carries marker");
ok(
  patchedPnpm != null && (patchedPnpm.match(/__vvRemapPnpmAlias\(/g) || []).length === 5,
  "pnpm-alias: patches all 4 fetchToStore sites + helper declaration",
);
ok(
  maybePatchPnpmStoreAliases(PNPM_SNIPPET.replace(/\n/g, "\r\n"), PNPM_FILE) === patchedPnpm,
  "pnpm-alias: CRLF source normalizes and patches identically",
);
ok(maybePatchPnpmStoreAliases(patchedPnpm, PNPM_FILE) === null, "pnpm-alias: already-patched source is a no-op");
ok(maybePatchPnpmStoreAliases(PNPM_SNIPPET, "/app/other.js") === null, "pnpm-alias: non-pnpm filename is a no-op");

let pnpmDriftWarned = false;
const origPnpmWarn = console.warn;
console.warn = (...a) => {
  if (String(a[0]).includes("pnpm store-alias patch did NOT apply")) pnpmDriftWarned = true;
};
ok(
  maybePatchPnpmStoreAliases("// unrecognised pnpm bundle\n".repeat(20), PNPM_FILE) === null,
  "pnpm-alias: drifted pnpm bundle returns null",
);
ok(pnpmDriftWarned, "pnpm-alias: drifted pnpm bundle warns loudly");
console.warn = origPnpmWarn;

// Functional execution of the patched fetchToStore against warm CAFS entries.
const makePnpmHarness = new Function(`
  const result2 = { fetchRawManifest: true };
  const removeKeyOnFail = (p) => p;
  const readBundledManifest = async (m) => m;
  const normalizeBundledManifest = (m) => ({ ...m });
  const path_1 = { default: { join: (a, b) => a + "/" + b } };
  const read_package_json_1 = { safeReadPackageJsonFromDir: async (p) => globalThis.__mockManifests[p] };
  const zipWith_1 = { default: (fn, a, b) => a.map((x, i) => fn(x, b[i])) };
  ${patchedPnpm}
  return { fetchToStore, getTopParents };
`);
const { fetchToStore: patchedFetchToStore, getTopParents: patchedGetTopParents } = makePnpmHarness();

async function runDoFetch(ctx, opts) {
  let resolved = null;
  let rejected = null;
  const { doFetchToStore } = patchedFetchToStore(ctx, opts);
  await doFetchToStore(
    "/store/idx.json",
    {
      resolve: (v) => { resolved = v; },
      reject: (e) => { rejected = e; },
    },
    "/store/target",
  );
  if (rejected) throw rejected;
  return resolved;
}

// 8a. Lockstep alias (lightningcss -> lightningcss-wasm) in warm store: no error, no warn, remapped name.
let pnpmWarnCount = 0;
const warmLightning = await runDoFetch(
  {
    strictStorePkgContentCheck: true,
    onWarn: () => { pnpmWarnCount++; },
    readPkgFromCafs: async () => ({
      verified: true,
      pkgFilesIndex: { name: "lightningcss-wasm", version: "1.33.0" },
      manifest: { name: "lightningcss-wasm", version: "1.33.0" },
      requiresBuild: false,
    }),
  },
  {
    pkg: { id: "lightningcss@1.33.0", resolution: {} },
    expectedPkg: { name: "lightningcss", version: "1.33.0" },
  },
);
ok(
  warmLightning && warmLightning.bundledManifest && warmLightning.bundledManifest.name === "lightningcss" && pnpmWarnCount === 0,
  "pnpm-alias: warm store lightningcss-wasm remaps to lightningcss with 0 warnings",
);

// 8b. Non-lockstep drop-in (bcrypt@6.0.0 -> bcryptjs@3.0.3) in warm store: remaps name AND version.
const warmBcrypt = await runDoFetch(
  {
    strictStorePkgContentCheck: true,
    onWarn: () => { pnpmWarnCount++; },
    readPkgFromCafs: async () => ({
      verified: true,
      pkgFilesIndex: { name: "bcryptjs", version: "3.0.3" },
      manifest: { name: "bcryptjs", version: "3.0.3" },
      requiresBuild: false,
    }),
  },
  {
    pkg: { id: "bcrypt@6.0.0", resolution: {} },
    expectedPkg: { name: "bcrypt", version: "6.0.0" },
  },
);
ok(
  warmBcrypt &&
    warmBcrypt.bundledManifest &&
    warmBcrypt.bundledManifest.name === "bcrypt" &&
    warmBcrypt.bundledManifest.version === "6.0.0",
  "pnpm-alias: warm store bcryptjs@3.0.3 remaps to bcrypt@6.0.0",
);

// 8c. Direct install of lightningcss-wasm still matches itself.
const directWasm = await runDoFetch(
  {
    strictStorePkgContentCheck: true,
    onWarn: () => { pnpmWarnCount++; },
    readPkgFromCafs: async () => ({
      verified: true,
      pkgFilesIndex: { name: "lightningcss-wasm", version: "1.33.0" },
      manifest: { name: "lightningcss-wasm", version: "1.33.0" },
      requiresBuild: false,
    }),
  },
  {
    pkg: { id: "lightningcss-wasm@1.33.0", resolution: {} },
    expectedPkg: { name: "lightningcss-wasm", version: "1.33.0" },
  },
);
ok(
  directWasm && directWasm.bundledManifest && directWasm.bundledManifest.name === "lightningcss-wasm",
  "pnpm-alias: direct lightningcss-wasm install stays lightningcss-wasm",
);

// 8d. Genuine mismatch (unrelated package in store) still throws ERR_PNPM_UNEXPECTED_PKG_CONTENT_IN_STORE.
let genuineMismatchCode = null;
try {
  await runDoFetch(
    {
      strictStorePkgContentCheck: true,
      onWarn: () => {},
      readPkgFromCafs: async () => ({
        verified: true,
        pkgFilesIndex: { name: "wrong-pkg", version: "1.0.0" },
        manifest: { name: "wrong-pkg", version: "1.0.0" },
        requiresBuild: false,
      }),
    },
    {
      pkg: { id: "expected-pkg@1.0.0", resolution: {} },
      expectedPkg: { name: "expected-pkg", version: "1.0.0" },
    },
  );
} catch (err) {
  genuineMismatchCode = err && err.code;
}
ok(
  genuineMismatchCode === "ERR_PNPM_UNEXPECTED_PKG_CONTENT_IN_STORE",
  "pnpm-alias: genuine store content mismatch still throws ERR_PNPM_UNEXPECTED_PKG_CONTENT_IN_STORE",
);

// 8e. getTopParents remaps an aliased direct dependency on disk back to its alias name,
// and ignores Object.prototype keys like "toString".
globalThis.__mockManifests = {
  "/nm/lightningcss": { name: "lightningcss-wasm", version: "1.33.0" },
  "/nm/vue": { name: "vue", version: "3.5.44" },
  "/nm/toString": { name: "toString", version: "1.0.0" },
};
const topParents = await patchedGetTopParents(["lightningcss", "vue", "toString"], "/nm");
delete globalThis.__mockManifests;
ok(
  Array.isArray(topParents) &&
    topParents.length === 3 &&
    topParents[0].alias === "lightningcss" &&
    topParents[0].name === "lightningcss" &&
    topParents[1].name === "vue" &&
    topParents[2].name === "toString",
  "pnpm-alias: getTopParents preserves source name for aliased direct dependencies and ignores prototype keys",
);

// 8f. Prototype property names (e.g. "toString") on expectedPkg do not throw in __vvRemapPnpmAlias.
const protoPkg = await runDoFetch(
  {
    strictStorePkgContentCheck: true,
    onWarn: () => { pnpmWarnCount++; },
    readPkgFromCafs: async () => ({
      verified: true,
      pkgFilesIndex: { name: "toString", version: "1.0.0" },
      manifest: { name: "toString", version: "1.0.0" },
      requiresBuild: false,
    }),
  },
  {
    pkg: { id: "toString@1.0.0", resolution: {} },
    expectedPkg: { name: "toString", version: "1.0.0" },
  },
);
ok(
  protoPkg && protoPkg.bundledManifest && protoPkg.bundledManifest.name === "toString" && pnpmWarnCount === 0,
  "pnpm-alias: Object.prototype key (toString) is not treated as an alias",
);

console.log("\nRESULT: " + (failures === 0 ? "PASS — toolchain subsystem intact" : `FAIL — ${failures} check(s) failed`));
process.exit(failures === 0 ? 0 : 1);
