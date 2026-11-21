---
"@vivari/core": minor
---

Debugger: breakpoints, stepping and `evaluateOnCallFrame` now reach Vite SSR/backend modules — code the ModuleRunner evaluates through `new AsyncFunction`, which never passes the require loader. Under `VV_DEBUG` the runtime patches the intrinsic AsyncFunction constructor before the entry loads and remaps lines through each module's inline source map, so breakpoints bind on the original `.ts` source and rebind across HMR re-evals; `new Function` / `vm.compileFunction` bodies naming a project `sourceURL` are covered too. Lines remap, identifier names do not yet; nothing installs without `VV_DEBUG`.
