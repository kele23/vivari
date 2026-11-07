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
