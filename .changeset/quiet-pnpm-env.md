---
"@vivari/core": patch
---

Kernel: pnpm's own config (store-dir, package-import-method, and the strict store-content
check the registry packument aliasing needs) is now set by the pnpm shim, in pnpm's
process, instead of in the base environment every command inherits. Those are
npm_config_* names, so npm 12 warned Unknown env config for them on every npm invocation
(and a future major turns that warning into an error) — and npm is the package manager a
project installs with.
