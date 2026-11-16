# Maintaining this fork

Fork of [maddogfinance/dsh-trading](https://github.com/maddogfinance/dsh-trading),
maintained for local use only. Nothing is published to npm — the `@dsh-trading` scope
belongs to the upstream author, and local `link:` paths are how the profile consumes
this checkout.

## Remotes

    origin    git@github.com:Jarekkkkk/dsh-trading.git     (ours — the source of truth)
    upstream  https://github.com/maddogfinance/dsh-trading.git

`main` tracks `origin/main`. Work lands on `main`; a branch is fine for anything that
takes more than one sitting.

## Sync

Pull our own work:

    git pull --ff-only

Take upstream's changes (their CI runs a daily canary against dsh rc bumps, so check
this when dsh upgrades):

    git fetch upstream && git merge --ff-only upstream/main

If the fast-forward is refused, upstream diverged from what we changed — resolve on a
branch, never force-push `main`.

## Toolchain notes for this machine

`~/Library/pnpm` is not writable, so pnpm's version self-management and its default
store both fail. Use:

    export npm_config_manage_package_manager_versions=false
    export npm_config_store_dir=~/dev/research/.pnpm-store
    pnpm install && pnpm build && pnpm typecheck && pnpm test

`typecheck` needs `build` to have run first: `client-chart` resolves
`@dsh-trading/market-data` through the workspace symlink into `lib/`.

Node here is 26.5.0 while CI pins 22. Node ≥22.4 exposes a real `sessionStorage`, which
the walkthrough player uses to remember performed sections — hence the `beforeEach`
clear in `packages/client-chart/test/walkthrough.test.ts`. Keep tests independent of
runtime web-storage support; do not reintroduce cross-test state.

## Known upstream defects we inherited

- `pnpm typecheck` fails on a clean clone (no build dependency, no TS project references).
- `@dsh-trading/{tool-market,verdict,risk-guard}@0.2.0` pin `@deepseek-ai/dsh-tools@0.1.0-rc.6`
  while the local dsh runtime is `0.2.2-rc.3`. A profile loading them needs an exact-version
  exemption until the peer is bumped.
