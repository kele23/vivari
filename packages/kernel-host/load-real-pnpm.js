// load-real-pnpm — put the REAL, unmodified pnpm CLI into the VFS and make `pnpm`
// (and `pnpx`) on PATH resolve to it.
//
// Sibling of load-real-npm.js / load-real-yarn.js. The browser-side counterpart to
// scripts/spike-pnpm.mjs: the pnpm tree is delivered as one gzipped asset (built by
// scripts/vendor-pnpm.mjs; same archive layout), fetched once by the kernel worker
// and unpacked into the VFS here. The SAME functions are exercised headlessly by
// scripts/spike-pnpm-studio.mjs.
//
// pnpm leans on things the other PMs don't: real worker_threads (dist/worker.js
// for fetch/extract) and a SYMLINKED node_modules (the VFS supports symlink /
// readlink / lstat). Hardlink/reflink CoW isn't available in our VFS, so the shell
// forces `--package-import-method=copy` via env (see kernel-worker openTerminal).
//
// Ordering: caller runs installCoreutils() FIRST, then ensureRealPnpm().

export const PNPM_VFS_ROOT = "/usr/lib/node_modules/pnpm";

// Thin shims on PATH. `node /bin/pnpm.js <args>` loads the real entry
// (bin/pnpm.cjs → bin/pnpm.mjs → dist/pnpm.mjs), which reads process.argv exactly like the
// spike's /run-pnpm.js wrapper proved. `pnpx` is pnpm's `dlx` alias.
//
// pnpm's config travels in env vars, and the npm_config_* spelling is npm's too: npm
// warns "Unknown env config" — and a future major turns that into an error — for every
// process that sees them, so they are set HERE, in pnpm's own process, instead of in the
// base process environment the kernel hands to every command (kernel-worker.ts).
// BOTH spellings, because pnpm 11 reads only pnpm_config_*: giving it the npm_config_*
// names alone (which 9.x and a corepack-downloaded release still read) would leave it on
// its own defaults — an unpersisted store, and the copy import method that duplicates
// every package's bytes in the VFS's Wasm RAM.
// HARD-LINK import method: node_modules entries share the store's inode instead of
// duplicating every package's bytes. The VFS supports link(2) (see OP_LINK); on a wasm
// build that predates it, fs.link falls back to a copy. The content-addressed store is
// persisted, so it is shared across projects/reloads.
const PNPM_ENV = `process.env.npm_config_package_import_method ||= "hardlink";
process.env.npm_config_store_dir ||= "/home/user/.local/share/pnpm/store";
process.env.pnpm_config_package_import_method ||= process.env.npm_config_package_import_method || "hardlink";
process.env.pnpm_config_store_dir ||= process.env.npm_config_store_dir || "/home/user/.local/share/pnpm/store";
// Update checks are pointless in the VM (you cannot \`npm i -g\` a new global) and
// pnpm's notifier spawns a detached background child that fails ENOENT here.
process.env.pnpm_config_update_notifier = "false";
// Required by the packument-alias rewrite (toolchain-shims.js): pnpm extracts the
// drop-in's tarball into CAFS under the source name, so a later install reading it back
// must not abort with ERR_PNPM_UNEXPECTED_PKG_CONTENT_IN_STORE.
process.env.npm_config_strict_store_pkg_content_check = "false";
process.env.pnpm_config_strict_store_pkg_content_check = "false";
`;
const PNPM_SHIM = `// Vivari: real pnpm shim — see packages/kernel-host/load-real-pnpm.js.
${PNPM_ENV}require(${JSON.stringify(PNPM_VFS_ROOT + "/bin/pnpm.cjs")});
`;
const PNPX_SHIM = `// Vivari: real pnpx shim — see packages/kernel-host/load-real-pnpm.js.
${PNPM_ENV}require(${JSON.stringify(PNPM_VFS_ROOT + "/bin/pnpx.cjs")});
`;

/** True once the real pnpm tree is present in the VFS (e.g. restored from OPFS).
 *  Checks the big bundle, not just the tiny bin, so a half-written tree isn't
 *  mistaken for a complete one. */
export function hasRealPnpm(kernel) {
  // dist/pnpm.mjs is pnpm 11's bundle. A tree an earlier session restored from OPFS
  // that only has 9.x's dist/pnpm.cjs fails this, so it is unpacked over again.
  return kernel.isFile(PNPM_VFS_ROOT + "/dist/pnpm.mjs");
}

// gunzip via the platform-native DecompressionStream (browser workers + Node ≥ 18).
async function gunzip(bytes) {
  const input = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  const stream = new Blob([input]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

/**
 * Decode the vendor asset into { version, files: [{ path, bytes }] }.
 * Layout: [u32le headerLen][headerJSON][file bytes ...] (all gzipped).
 */
export async function decodePnpmPack(packBytes) {
  const raw = await gunzip(packBytes);
  const view = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
  const headerLen = view.getUint32(0, true);
  const headerJson = new TextDecoder().decode(raw.subarray(4, 4 + headerLen));
  const header = JSON.parse(headerJson);
  const blobStart = 4 + headerLen;
  const files = header.files.map((f) => ({
    path: f.p,
    bytes: raw.subarray(blobStart + f.o, blobStart + f.o + f.l),
  }));
  return { version: header.version, files };
}

/**
 * Overwrite /bin/pnpm.js and /bin/pnpx.js so the shell resolves the real CLI.
 * Safe to call on every boot (idempotent).
 */
export function applyRealPnpmShims(kernel) {
  kernel.writeFile("/bin/pnpm.js", PNPM_SHIM);
  kernel.writeFile("/bin/pnpx.js", PNPX_SHIM);
}

/**
 * Unpack the pnpm tree into the VFS and install the shims. `packBytes` is the
 * gzipped vendor asset. The whole tree is written in one batched transfer.
 */
export async function loadRealPnpm(kernel, packBytes) {
  const { version, files } = await decodePnpmPack(packBytes);
  // One batched transfer (mkdirp + write in the FS Worker). Rides the whole tree
  // (including pnpm's ~15.6 MB dist/pnpm.mjs) over a single transferable buffer.
  await kernel.writeFilesBatch(files.map((f) => ({ path: PNPM_VFS_ROOT + "/" + f.path, bytes: f.bytes })));
  applyRealPnpmShims(kernel);
  return { version, fileCount: files.length };
}

/**
 * Ensure the real pnpm is active. If already in the VFS (OPFS-restored), just
 * (re)apply the shims — cheap. Otherwise fetch + unpack via `fetchPackBytes()`.
 * Returns a small status object, or null if the asset was unavailable (caller
 * simply has no `pnpm` on PATH).
 */
export async function ensureRealPnpm(kernel, fetchPackBytes) {
  if (hasRealPnpm(kernel)) {
    applyRealPnpmShims(kernel);
    return { version: null, fileCount: 0, restored: true };
  }
  const packBytes = await fetchPackBytes();
  if (!packBytes) return null;
  const res = await loadRealPnpm(kernel, packBytes);
  return { ...res, restored: false };
}
