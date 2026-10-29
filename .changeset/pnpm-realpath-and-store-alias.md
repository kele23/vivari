---
"@vivari/core": patch
---
Resolve symlinks in `fs.realpathSync.native` / `fs.realpath.native` (`binding.realpath`) so Vite's dependency optimizer can follow `pnpm`'s `.pnpm` symlink layout, and remap registry-aliased WASM packages (`lightningcss-wasm`, `esbuild-wasm`, `@rollup/wasm-node`, `bcryptjs`) when `pnpm` reads back from its content-addressed store so subsequent `pnpm` commands no longer fail with `ERR_PNPM_UNEXPECTED_PKG_CONTENT_IN_STORE` (GitHub issue #17).
