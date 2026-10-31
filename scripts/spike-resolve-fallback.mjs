// Spike (OFFLINE): the module resolver falls back to the next entry point when the
// one it prefers is missing from disk.
//
// Packages published as pruned, ESM-only copies keep a `main` / `exports.require`
// that points at a CJS file the tarball no longer ships. nitro's traced
// dist/node_modules is the case that surfaced this: `defu` declares
// `main: ./lib/defu.cjs` and `exports["."].require -> ./lib/defu.cjs`, but only
// `dist/defu.mjs` is on disk. Node takes the `import` condition and loads it; our
// resolver used to stop at the first condition it picked and throw
// MODULE_NOT_FOUND, so nitro died at boot.
//
// The fallback must only kick in when the preferred target is genuinely missing.
// A healthy dual package still resolves to its CJS build, and a package with no
// loadable file at all still throws.
//
// createModuleSystem runs over host Node's fs, so this exercises the shipped
// resolver and loader with no kernel and no Wasm.
//
// Run:  node scripts/spike-resolve-fallback.mjs

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createModuleSystem } from "../packages/runtime/module.js";

let failures = 0;
const check = (label, cond) => {
  console.log(`  ${cond ? "ok  " : "FAIL"}  ${label}`);
  if (!cond) failures++;
};

const root = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "vv-resolve-")));
const write = (rel, body) => {
  const abs = path.join(root, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, typeof body === "string" ? body : JSON.stringify(body));
};

const sys = createModuleSystem({
  fs,
  path,
  builtins: {},
  process,
  nodeModules: { has: () => false, require: () => ({}), internalBinding: () => ({}) },
});
// Resolved path relative to the fixture root, or the error message.
const resolve = (id) => {
  try {
    return path.relative(root, sys.resolveFilename(id, root).id);
  } catch (e) {
    return "THROW " + e.message.split("\n")[0];
  }
};

try {
  // nitro's defu, as published: both CJS pointers dangle, only the ESM build exists.
  write("node_modules/defu/package.json", {
    name: "defu",
    main: "./lib/defu.cjs",
    module: "./dist/defu.mjs",
    exports: { ".": { import: "./dist/defu.mjs", require: "./lib/defu.cjs" } },
  });
  write("node_modules/defu/dist/defu.mjs", "export function defu(a, b) { return { ...b, ...a }; }\nexport default defu;\n");

  // No `exports`: `main` dangles, `module` exists.
  write("node_modules/main-gone/package.json", { name: "main-gone", main: "./cjs/index.js", module: "./esm/index.js" });
  write("node_modules/main-gone/esm/index.js", "export const from = 'module';\n");

  // Conditions nested under `node`, with the inner `require` missing.
  write("node_modules/nested/package.json", {
    name: "nested",
    exports: { ".": { node: { require: "./node.cjs", import: "./node.mjs" }, default: "./browser.js" } },
  });
  write("node_modules/nested/node.mjs", "export const from = 'node.import';\n");
  write("node_modules/nested/browser.js", "module.exports = { from: 'default' };\n");

  // A subpath export with the same pruning. The targets live under a different
  // directory than the subpath name on purpose: with `./util.mjs` at the package
  // root, the resolver's plain `<pkg>/util` + extension probe finds the file
  // without ever reading `exports`, and this case would pass with no fallback.
  write("node_modules/sub/package.json", {
    name: "sub",
    exports: { "./util": { require: "./lib/util.cjs", import: "./esm/util.mjs" } },
  });
  write("node_modules/sub/esm/util.mjs", "export const from = 'sub.import';\n");

  // A healthy dual package: both builds exist, so require() must keep the CJS one.
  write("node_modules/dual/package.json", {
    name: "dual",
    main: "./index.cjs",
    module: "./index.mjs",
    exports: { ".": { import: "./index.mjs", require: "./index.cjs" } },
  });
  write("node_modules/dual/index.cjs", "module.exports = { from: 'cjs' };\n");
  write("node_modules/dual/index.mjs", "export const from = 'esm';\n");

  // Nothing loadable anywhere: the fallback must not invent a file.
  write("node_modules/empty/package.json", {
    name: "empty",
    main: "./gone.cjs",
    module: "./gone.mjs",
    exports: { ".": { require: "./gone.cjs", import: "./gone.mjs" } },
  });

  console.log("\n== [resolve] a missing CJS target falls back to a build that exists ==");
  check(`exports: missing "require" falls back to "import" (${resolve("defu")})`, resolve("defu") === "node_modules/defu/dist/defu.mjs");
  check(`no exports: missing "main" falls back to "module" (${resolve("main-gone")})`, resolve("main-gone") === "node_modules/main-gone/esm/index.js");
  check(`nested conditions: node.require missing -> node.import before default (${resolve("nested")})`, resolve("nested") === "node_modules/nested/node.mjs");
  check(`subpath export: missing "require" falls back to "import" (${resolve("sub/util")})`, resolve("sub/util") === "node_modules/sub/esm/util.mjs");

  console.log("\n== [resolve] nothing changes when the preferred target exists ==");
  check(`healthy dual package still resolves to its CJS build (${resolve("dual")})`, resolve("dual") === "node_modules/dual/index.cjs");
  check(`no loadable file at all still throws (${resolve("empty")})`, /^THROW Cannot find module 'empty'/.test(resolve("empty")));

  console.log("\n== [resolve] the fallback file actually loads ==");
  // Resolving is half of it: the ESM copy has to come back from require() as a
  // usable module, which is what nitro needed.
  const req = sys.makeRequire(root);
  let defu = null;
  try {
    defu = req("defu");
  } catch (e) {
    console.log("    require('defu') threw: " + e.message.split("\n")[0]);
  }
  const merge = defu && (defu.defu || defu.default);
  check("require('defu') loads the ESM-only copy", typeof merge === "function");
  check("…and it works", typeof merge === "function" && JSON.stringify(merge({ a: 1 }, { a: 2, b: 3 })) === '{"a":1,"b":3}');
  check("require('dual') still gets the CJS exports", req("dual").from === "cjs");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log(`\nRESULT: ${failures === 0 ? "PASS: the resolver falls back only when the preferred target is missing" : `FAIL: ${failures} check(s) failed`}`);
process.exit(failures === 0 ? 0 : 1);
