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
  - pnpm config moved out of the base process environment (`c20e0e9`) — it matters only
    with the vendored npm 12 pin, which upstream does not carry.
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
  between export and its declaration` (`c9a9ecc`, branch `fix/esm-comment-after-export`).
- [#30](https://github.com/maitrungduc1410/vivari/pull/30) — `fix(vendor): rebuild a pack whose
  stamped version no longer matches` (`7483504`, branch `fix/vendor-stale-pack-version`).
- [#31](https://github.com/maitrungduc1410/vivari/pull/31) — `fix(runtime): never let a relative
  path become a file URL host` (`9184ee5` + `36c9714`, branch `fix/file-url-host`). Fixes the
  fork's issue #1 (`import.meta.url` gaining a bogus host).
- All three are rebased on the `v1.2.0` tag (`9c87dec`).
- `1fc1094` cannot go upstream alone: it fixes `hydrate()`, which only exists after
  `8fd62fe`.
- `c8ae8ed` (npm 12.2.1) is a chore coupled to `c20e0e9`; the bump was completed in
  `9aa7682` (version gates, vendor provisioning and current-state docs now match the pin).

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

The five `fix/*` branches merged upstream (PRs #19–#23) and the `facilis/pre-v1.1.5`
pre-rebase backup were deleted from `origin` on 2026-10-31. `facilis/main`, `master` and
the three open-PR branches remain; delete those when their PRs merge.

## Syncing with upstream

```sh
git fetch upstream
git rebase upstream/master      # fork-only commits stay on top
npm run spikes:offline          # after npm install; Wasm spikes need npm run build
```

Realigned onto the `v1.2.0` tag (`9c87dec`) on 2026-10-31: the fork-only commits are
replayed on top, `e2f4246` stays out, and its revert commit is gone with it. When a PR
merges upstream, drop its commit from the replay.

Upstream `v1.2.0` is itself red in CI: `toolchain-gate`/`toolchain-floor` fail in the
`ci-tiers` spike (the `needsWasm` spike-wiring check), the same failure as on `master` at
`9c87dec`, so it is not caused by this fork's changes.
