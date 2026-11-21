# Fork notes

This repository is [`kele23/vivari`](https://github.com/kele23/vivari), a fork of
[`maitrungduc1410/vivari`](https://github.com/maitrungduc1410/vivari) (MIT). `facilis/main`
is `upstream/master` plus a small, deliberate delta. Keep the delta small: generic fixes go
upstream as small PRs, everything else is justified and recorded here.

## Policy (2026-10-31)

- **Upstream PRs: simple, self-contained fixes only.** Features that change the public SDK
  surface are discussed in an upstream issue first, and stay fork-only until then.
- **Fork-only, by decision:**
  - `BootOptions.deferRestoreRoots` / `vv-restore-roots` (`8fd62fe`)
  - `BootOptions.deferCacheFiles` (`7725413`)
  - pnpm config moved out of the base process environment (`c20e0e9`) — the pnpm shim sets it
    in pnpm's own process instead of the environment every command inherits. It was written for
    the npm 12.2.1 pin and is kept now that the pin is gone: those are `npm_config_*` names, so
    an npm invocation in the same environment sees another package manager's configuration.
  - The breakpoint debugger's SSR eval seam (`installEvalSeam` in `packages/runtime/debugger.js`,
    kele23/vivari#5 Option 1) — internal runtime glue behind `VV_DEBUG`, no public SDK surface
    change; a feature rather than a self-contained fix, so it stays fork-only.
- **Scope: the whole project except `packages/studio`.** The Studio IDE app is the downstream
  product's business: it keeps its own fork of it (`ide/` in `facilis-dev/facilis`) and its
  own copy of the preview Service Worker (`ide/public/sw.js`). One coupling to know —
  `@vivari/core` vendors `packages/studio/public/sw.js` into `dist/assets/sw.js` at build
  time, so the preview SW ships with core even though its canonical copy lives in studio, which
  makes a preview-SW fix IDE-side **by decision, not by architecture**.
- **Signalling the downstream means a GitHub issue in `facilis-dev/facilis`, never a change to
  its files.** A finding that belongs to the IDE is reported there (diagnosis, repro, design,
  patch in the body) and implemented there; this working tree, the downstream's working tree
  and the submodule worktree are all left alone.
- **No downstream-specific code in this repository.** Product templates, assets, probes or
  branding belong to the downstream product, which pins this fork as a submodule.
- Fork-only commits keep changesets while they touch `@vivari/core`.

## Upstream work

- [#29](https://github.com/maitrungduc1410/vivari/pull/29) — `fix(runtime): skip comments
  between export and its declaration`. **Merged**; the fork's copy (`c9a9ecc`) drops out on
  rebase.
- [#30](https://github.com/maitrungduc1410/vivari/pull/30) — `fix(vendor): rebuild a pack whose
  stamped version no longer matches` (`8120097`, merged in `40bc625`, branch
  `fix/vendor-stale-pack-version`). **Merged**; the fork's copies (`34e1d16` + `9ed4181`) drop
  out on rebase.
- [#31](https://github.com/maitrungduc1410/vivari/pull/31) / [#32](https://github.com/maitrungduc1410/vivari/pull/32) —
  `fix(runtime): never let a relative path become a file URL host`, merged and then reverted
  upstream. Superseded by #35.
- [#35](https://github.com/maitrungduc1410/vivari/pull/35) — `fix(runtime): keep file: URLs
  host-free, and recover the path when a parser adds one` (branch `fix/file-url-host-v2`).
  Restores #31's content, applies its review feedback (a literal `%` in `pathToFileURL`, the
  recovery shared by every call site, and the verbatim script-URL pair both CDP backends use),
  and the Windows reporter confirmed the fix on their machine. **Merged** (`3ae0dda`, released in
  `v1.2.1`); the fork's copies — three URL commits and the two `file-url-*` changesets — drop out
  on rebase.
- Realigned on `upstream/master` (`d2719f9`, 2026-11-03, after #35 merged and `v1.2.1` was
  released). The npm 12.2.1 pin, its provisioning follow-up and its revert drop out too: upstream
  carries 10.9.2, which is where the branch had settled.
- `1fc1094` cannot go upstream alone: it fixes `hydrate()`, which only exists after
  `8fd62fe`.

## Removed fork-only work

- `e2f4246` (template `assets`) is reverted: it existed only for the downstream product's
  local-tarball templates and had no contract, consumer, test or changeset here. A downstream
  embedder can pass bytes through the create message's `files` (`writeFilesBatch` already
  accepts them).

## Downstream (Facilis) work

Reported there as issues, never implemented here:

- [#4](https://github.com/facilis-dev/facilis/issues/4) — preview Service Worker: a reload can
  serve the other IDE tab's project once Chrome evicts the idle worker. The routing state is in
  SW memory only (`frameKernel`, `kernelByToken`, `kernelHostIds`, per-tab keep-prefix) and
  nothing re-announces an open page (`vv-kernel-host` is sent at registration and on
  `controllerchange`, not per `listen`), so after an eviction every preview request falls back
  to `pickKernelClient`; with two tabs both serving 5173 the wrong one answers 200. The issue
  carries the diagnosis, the repro, the design and a patch against `ide/public/sw.js`. No change
  kept here (scope: `packages/studio`); the spike work that gated it was reverted with it.

## Branch hygiene

`origin` carries two branches and nothing else: `facilis/main` (the one the downstream
pins) and `master` (a mirror of `upstream/master`, nothing committed on it). Both are
pushed by the sync block below, so a clone can see which upstream commit the fork is on
without fetching upstream first.

The five `fix/*` branches merged upstream in PRs #19–#23 and the `facilis/pre-v1.1.5`
pre-rebase backup were deleted on 2026-10-31. The four PR branches that stayed behind
(#29 #30 #31 #35 — `fix/esm-comment-after-export`, `fix/vendor-stale-pack-version`,
`fix/file-url-host`, `fix/file-url-host-v2`) were deleted on 2026-11-07, once every one of
them was verified to be an ancestor of `upstream/master`: nothing on them exists only here.
All upstream tags were pushed to `origin` at the same time, so the fork's tag list matches
the releases the code is actually on. Delete a PR branch when its PR merges — the commits
survive upstream, and a branch left behind is a claim the fork still carries work it does
not.

Six `backup/*` refs stay **local only** and are never pushed:
`backup/facilis-main-2026-10-31`, `…-2026-10-31-sync1`, `…-2026-11-03`, `…-2026-11-15`,
`…-2026-11-20` and `backup/pr35-pre-rebase` are the pre-rebase states of `facilis/main` and
of PR #35. They are the only record of the commits a rebase dropped, so they are kept while
the drop list in this file still refers to them by sha.

## Syncing with upstream

**This is a standing task, not a one-off: realign after every batch of changes and whenever
`upstream/master` moves.** `master` must stay exactly at `upstream/master` (it is the sync
base, nothing is committed on it), and `facilis/main` must be rebased on top of it — the
downstream product pins this branch, so a stale fork means the fix it is testing may not be in
the tree. Replay drops a fork commit whose patch upstream already merged; that is the signal
the PR landed.

```sh
git fetch upstream --tags
git branch -f master upstream/master          # master tracks upstream exactly
git checkout facilis/main
git rebase upstream/master                     # fork-only commits stay on top
node scripts/spike-esm.mjs                     # the offline gates that need no install
node scripts/spike-bun-offline.mjs
node scripts/spike-ci-tiers.mjs
npm run spikes:offline                         # after npm install; Wasm spikes need npm run build
git push origin master                         # fast-forward; the fork's mirror of upstream
git push origin --tags                         # the release the tree is on
git push --force-with-lease origin facilis/main
```

**`master` and the tags are part of "aligned", not an optional extra.** Leaving them behind
is the failure this block was extended for: on 2026-11-07 `facilis/main` was current and
`origin/master` was still at `9c87dec` (the `v1.2.0` merge: one release and four commits
behind) with only two of the twelve release tags pushed, so the fork advertised a base it
had not been on for a week. The two pushes are fast-forwards and additive respectively —
neither can rewrite `facilis/main`'s history, and the force-push is the last step on purpose.

Realigned onto `upstream/master` (`a9e3aac`) on 2026-10-31: #29's merge dropped the fork's
copy of it, #31's revert dropped nothing (the fork never carried the throw), and the 18
remaining fork-only commits were replayed on top. Realigned again on `d2719f9` on 2026-11-03
after #35 merged and `v1.2.1` was released. Checked on 2026-11-07: upstream had not moved
(`d2719f9` was still `upstream/master`, `v1.2.1` still the latest release, no open PRs), so
that run only closed the divergence in `origin`'s `master` and tags.

Upstream `v1.2.0` was red in CI — `toolchain-gate`/`toolchain-floor` failed the `ci-tiers`
spike — and the fork inherited that, which is why `scripts/spike-ci-tiers.mjs` was missing
from this block: a gate that is red on the base cannot tell you anything about the branch.
The cause was the gate itself, not the runtime: it found a job's spike list by matching the
*first* filtered `--offline` line in `ci.yml`, and the node:sqlite step added ahead of the
Wasm step became that line, so it reported 32 Wasm spikes as selected by no job. Fixed
upstream in `78cd665` (find the step by name; `7b2d779` pinned the Node the sibling
differential job compares against). It passes at `d2719f9`, so it is in the block now, and
it is worth knowing the failure mode: a gate that locates its subject by "the first match"
breaks when an unrelated step is inserted above it, and looks exactly like a product bug.

Realigned onto `upstream/master` (`4fbb009`, tagged `v1.3.0`) on 2026-11-12: three upstream
commits (pnpm 11, SDK `snapshot()`/`restore()`, terminal size). Nothing dropped — no fork-only
commit was superseded, which is consistent with the fork having no PR in flight since #35. Two
conflicts, both resolved as a union: `kernel-fs.js` adds upstream's `snapshotTree`/`restoreTree`
next to the fork's `restoreRoots`, and `kernel-worker.ts` keeps the fork's "no pnpm config in
the base process env" comment while dropping the block upstream's pnpm-11 commit had extended.

**The pnpm commit needed a real fix to survive, and that is the one to remember.** pnpm 11
reads only `pnpm_config_*`, never `npm_config_*`; upstream's fix was to give every setting in
`baseProcEnv` both spellings. The fork's `c20e0e9` had moved those settings out of there into
the pnpm shim, under the `npm_config_*` spelling alone — so replaying it verbatim would have
left pnpm 11 with no config at all (its default non-persisted store and copy import method),
and `spike-pnpm-studio`'s new `storeHonoured` gate would have been the only thing to say so.
The shim now sets both spellings for its own process (`load-real-pnpm.js`), which is what makes
the fork's premise — npm sees a clean environment — hold with pnpm 11 as the shipped PM.

Realigned onto `upstream/master` (`460ba69`, tagged `v1.3.1`) on 2026-11-15, the same day the
mirror-lane fix merged as PR #4 (merge commit `c5a5d40`, two commits, `@vivari/core` changeset
minor). Upstream's four commits were the v1.3.1 release (the nightlies' template-gate/spikes-net
fixes: npm-target-platform for the `--cpu=wasm32` lock resolve, the ESM parse5 comment fix, the
Ember HTML-entity decode) plus the release version bumps. Eighteen fork commits replayed. One
conflict, resolved as a union: `roadmap.md`, where upstream appended its nightly-red section
exactly where #3's mirror-lane entry appends — both sections are kept, and the lane's review-fix
entry follows them. The lane files themselves replay byte-identical. Gates after the realign:
`spike-esm`, `spike-bun-offline` and `spike-ci-tiers` PASS, `npm run verify` PASS, offline tier
67/69 with the two expected host failures (`python-offline` needs the host pip; `clean-checkout`
re-runs it on a tracked-only tree — the same pair fails on the pre-realign tree). Pre-rebase
state kept local-only as `backup/facilis-main-2026-11-15` (`c5a5d40`).

Realigned onto `upstream/master` (`9372e5e`) on 2026-11-20: three releases since v1.3.1
(v1.3.2, v1.3.3, v1.3.4) plus one post-release spike fix. v1.3.2 extracted the
manifest-report rules into `packages/core/manifest-report.js` and named the mid-transfer
2xx body as a transient shape; v1.3.3 fixed the UNIX-socket file (#44/#45, Nuxt 4's
vite-node socket), sent COEP/CORP on the preview token redirect, and put `probe-xpipe` in
CI; v1.3.4 gave `file:` URLs with a query/hash their own module (the Nuxt config reload)
and web streams Node's closed-promise (the `pnpm add` stall), with the timing gap pinned;
`9372e5e` makes `spike-web-globals`' browser-like streams work on Node 22. Nineteen fork
commits replayed, nothing dropped — the pnpm-env commit passed unchanged this time. One
conflict, resolved as a union: `roadmap.md`, where upstream appended its three release
sections exactly where the mirror-lane paragraph appends — both kept, the lane paragraph
last; the range-diff shows the other 18 commits byte-identical and the lane files
unchanged. Gates after the realign: `spike-esm`, `spike-bun-offline` and `spike-ci-tiers`
PASS, `npm run verify` PASS, offline tier 70/72 with the two expected host failures
(`python-offline` needs the host pip; `clean-checkout` re-runs it on a tracked-only tree
and reports the checkout is not the cause — the same pair fails on the pre-realign tree).
Pre-rebase state kept local-only as `backup/facilis-main-2026-11-20` (`daceb39`).

Realigned onto `upstream/master` (`1c0de76`, tagged `v1.3.5`) on 2026-11-21: one release
since v1.3.4. PR #52 made the terminal behave like a real machine — TTY stdout with Node's
`emitKeypressEvents`, one SIGINT per Ctrl-C, JSON fork messages,
`process.getActiveResourcesInfo()`, bare `/bin` names on PATH, Safari's `ReadableStream`
async iterator — and the preview SW now drops `X-Frame-Options`/`frame-ancestors` so a
Nitro error page renders in the preview frame (upstream's studio copy; the IDE keeps its
own `sw.js` and may want the same hunk). Twenty fork commits replayed, nothing dropped.
One conflict, resolved as a union: `roadmap.md`, where upstream appended its #52 section
exactly where the mirror-lane paragraph appends — both kept, the lane paragraph last; the
range-diff shows the other 19 commits byte-identical and the lane files unchanged.
Mid-sync, PR #6 (the SSR-eval debug seam) merged into `origin/facilis/main` (`54687fc`);
the first `--force-with-lease` push rejected as stale is what surfaced it. Its commit
(`80efb29`) was cherry-picked on top of the replay to keep the branch linear — the merge
was trivial, so the content is identical. Gates on the final tree: `spike-esm`,
`spike-bun-offline`, `spike-ci-tiers`, `spike-debugger` and `spike-debugger-ssr-seam`
PASS, `npm run verify` PASS, `spike-debugger-ssr` (net, in-VM acceptance) PASS, offline
tier 74/76 with only the two expected host failures (`python-offline` needs the host pip;
`clean-checkout` re-runs it on a tracked-only tree). An earlier tier run on the
pre-cherry-pick tree flaked `port-liveness` (`worker-unref-then-listen`, a
message-delivery race): 3/3 standalone re-runs, the pre-realign tree and both full-tier
re-runs are green on it — a timing flake, not a regression. Pre-rebase state kept
local-only as `backup/facilis-main-2026-11-21` (`d2a8d52`).

