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

## How the profile consumes this checkout

`~/.dsh/profiles/trading` no longer installs the published packages. Its
`package.json` keeps `@dsh-trading/bundle` (for the row wiring) and adds the six
packages as `link:` dependencies:

    "@dsh-trading/tool-market": "link:/Users/jareklin/dev/research/dsh-trading/packages/tool-market"
    ...client-chart, market-data, provider-csv, risk-guard, verdict

So the profile points at `lib/` in this checkout, live. After changing source:

    pnpm build            # in this repo
    # restart the workbench — no reinstall needed

The old exact-version exemptions are gone: the packages now declare
`@deepseek-ai/dsh-tools@0.2.2-rc.3`, matching the local runtime, so the loader accepts
them without `compatibility.json`.

pnpm `file:` dependencies copy the package; `link:` symlinks it. Use `link:`, or every
edit needs a reinstall.

## Debugging note: verify your capture is live

A whole afternoon went into a "the chart card never renders" bug that did not exist. The
card was fine; it renders inside the collapsed work-details fold of a finished turn
(`Completed in Ns`, click to expand). What wasted the time was trusting screenshots from
an automation browser that returned a **frozen frame** — two consecutive captures came
back byte-identical after a click and a scroll while the DOM changed underneath.

Before concluding that something did not render, make the capture prove it is live: two
captures that must differ (a click, a scroll, a different tab), or a real-browser window
grab, or a human glance at the screen.

## Known upstream defects we inherited

- `pnpm typecheck` fails on a clean clone (no build dependency, no TS project references).
- `@dsh-trading/{tool-market,verdict,risk-guard}@0.2.0` pin `@deepseek-ai/dsh-tools@0.1.0-rc.6`
  while the local dsh runtime is `0.2.2-rc.3`. A profile loading them needs an exact-version
  exemption until the peer is bumped.

## The chart column rides dsh own right sidebar

`@dsh-trading/client-chart` puts a persistent chart beside the conversation without
touching the shell. `client-frame` is NOT used: that package owns `ui-layout`, and when its
0.1.0-rc.6 layout contract met dsh 0.2.2 the entire client failed to boot. Here one row fails
at worst.

What the integration needs, all learned from the running runtime:

- register a tab *type* via the `sidebarRightTabs` service, and wait for that service with
  `ctx.inject([...])` — reading it with `ctx.get` at apply time silently loses the tab;
- claim the body in the keyed slot `sidebar.right.pane.tab` under BOTH the tab kind and the
  tab id: the pane renders `entryKey = definition.id ?? tab.kind`, and only the id matches
  once the definition is registered;
- claim `sidebar.right.pane.tab.title` the same way, or the tab renders as a blank chip;
- `openTab` refuses until a conversation surface is mounted and publishes no event for that,
  so retry a bounded 30x2s; then `toggleExpanded()` — a tab in a collapsed bar is invisible;
- a `guide` entry in the tab definition is what makes a closed tab reopenable: the strip "+"
  opens the guide tab, which lists those entries by title.

Break risk: the two controller calls (`openTab`, `toggleExpanded`) are outside the documented
slot contract. A future rc that moves them breaks this row only.
