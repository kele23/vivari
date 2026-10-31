---
"@vivari/core": patch
---

Kernel: when an on-demand tool (`npm`, `yarn`, `pnpm`, `corepack`, `tsc`) cannot be loaded, the reason is printed in the terminal that ran the command instead of only `sh: npm: not found`, and the next run retries. A missing vendor asset now counts as a failed load, whether the server answers 404 or serves an HTML page in its place (a dev server or SPA fallback); it used to count as a finished one, which left the tool unavailable until a reload.
