---
"@vivari/core": patch
---

Kernel: pnpm's own config (store-dir, package-import-method, and the strict store-content
check the registry packument aliasing needs) is now set by the pnpm shim, in pnpm's
process, instead of in the base environment every command inherits. Those are
npm_config_* names, so an npm invocation inherited another package manager's configuration
(and the unknown-env-config warning that comes with it on newer npm majors) — and npm is the
package manager a project installs with.
