/**
 * Browser half: claims the keyed `tool.call.toolview` slot for the two
 * tool-market tools whose results carry a chart payload. Keys are wire tool
 * names; an unclaimed key falls back to dsh's generic card, so hosts without
 * this package lose nothing.
 */
import type { ClientContext } from '@deepseek-ai/dsh-client-runtime/client'
import type { ConnectionHandle } from '@deepseek-ai/dsh-client-connection/client'
// Type-only: brings the trading frame's `trading.chart` slot declaration into
// scope. Same pattern as the ui-tool dependency above — a slot contract, not a
// runtime import, so a profile without the frame still loads this plugin.
import type {} from '@dsh-trading/client-frame/client'
import { createElement, useEffect, useRef, useState } from 'react'
import { ChartCard } from './ChartCard.js'
import { ChartPanel } from './ChartPanel.js'
import { createMarketClient } from './market-client.js'
import type { MarketClient } from './market-client.js'
import { WalkthroughCard } from './WalkthroughCard.js'

// The ecosystem seam: third-party dsh client plugins require
// '@dsh-trading/client-chart/client' (mark it external in your bundle — the
// dsh module loader resolves rostered plugin bundles by package name) and
// register PURE renderers for annotation types this card has never heard of.
export { registerAnnotationRenderer } from './ChartCard.js'
export type { AnnotationRenderer, AnnotationRendererContext, DrawPrimitive } from './ChartCard.js'
export type { ChartAnnotation, ChartPayload, ChartScenario, ChartTimeframeData } from './payload.js'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /**
     * One right-sidebar pane body (dsh >= 0.2). Keyed by tab kind, session scoped:
     * the sidebar registers tab *types* and this plugin supplies the body named by
     * the kind. Declared here rather than upstream because dsh does not publish the
     * key in its client typings — only its own sidebar packages use it.
     */
    'sidebar.right.pane.tab': { kind: 'keyed'; scope: 'session'; owner: { market: MarketClient } }
    'sidebar.right.pane.tab.title': { kind: 'keyed'; scope: 'session'; owner: Record<string, never> }
  }
}

/**
 * The sidebar tab body: the same column the trading frame seats, sized by its host
 * rather than by the frame (no frame is mounted here).
 */
/** The tab label. An empty title renders as a blank chip in the tab strip. */
function ChartTabTitle(): JSX.Element {
  return createElement('span', null, 'Chart')
}

function SidebarChart(props: { market: MarketClient }): JSX.Element {
  const [width, setWidth] = useState(640)
  const ref = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const el = ref.current
    if (el === null) return
    const observer = new ResizeObserver(() => { if (el.clientWidth > 0) setWidth(el.clientWidth) })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])
  return createElement('div', { ref, style: { height: '100%', overflow: 'auto' } },
    createElement(ChartPanel, { width, market: props.market }))
}
export const name = 'client-chart'
export const inject = ['slots', 'connection']

const CHART_TOOLS = ['market_snapshot', 'get_ohlcv', 'annotate_chart']

/** The slice of `ctx.sessions` a reply needs: reach one session and send it a message. */
interface SessionsLike {
  scope(id: string): unknown
  sessionOf(scope: unknown): { prompt(content: { type: 'text'; text: string }[], mode: 'queue' | 'steer'): Promise<unknown> } | undefined
}

/**
 * Send the reader's tapped reply as their next message, exactly as if typed.
 * Looked up at click time rather than injected at apply: a profile without
 * the sessions service still loads this plugin, and the reply degrades to a
 * logged warning instead of a pending plugin row.
 */
function sendReply(ctx: ClientContext, sessionId: string, text: string): void {
  const sessions = ctx.get('sessions') as SessionsLike | undefined
  const scoped = sessions?.scope(sessionId)
  const session = scoped !== undefined ? sessions!.sessionOf(scoped) : undefined
  if (session === undefined) {
    console.warn('[client-chart] cannot reach the session to send a walkthrough reply')
    return
  }
  void session.prompt([{ type: 'text', text }], 'queue')
}

export function apply(ctx: ClientContext): void {
  // register() throws on undeclared slots — inject() waits for dsh-client-ui-tool
  // to declare 'tool.call.toolview' and re-runs across HMR redeclarations.
  ctx.slots.inject('tool.call.toolview', () => [
    ...CHART_TOOLS.map(key =>
      ctx.slots.register(
        { name: 'tool.call.toolview', key, registrant: '@dsh-trading/client-chart' },
        ChartCard,
      )),
    ctx.slots.register(
      {
        name: 'tool.call.toolview',
        key: 'walkthrough',
        registrant: '@dsh-trading/client-chart',
        inject: (sessionId: string) => ({ ask: (text: string) => sendReply(ctx, sessionId, text) }),
      },
      WalkthroughCard,
    ),
  ])

  // The persistent column, claimed the same way: inject() means a profile
  // running dsh's stock frame (no `trading.chart` declarer) simply never runs
  // this callback, and the cards above still work.
  //
  // The registration's `inject` face is how the panel reaches the host without
  // importing cordis: a slot component receives only framework props, so the
  // data client is bound here, in the one place that legitimately holds ctx.
  // `ctx.connection` is provided by dsh-client-connection; read it through
  // ctx.get so this package need not merge that plugin's Context augmentation
  // into a compilation that deliberately runs with `types: []`.
  const connection = ctx.get('connection') as ConnectionHandle
  const market = createMarketClient(connection.rpc)

  // dsh 0.2.x ships a right sidebar whose tabs are a registry, not a fixed set: a plugin
  // registers a tab *kind* plus the body keyed by that kind. That is the sanctioned way to
  // put a persistent chart beside the conversation without replacing the shell (which
  // client-frame does — and which a version bump broke catastrophically).
  const withTabs = (): void => {
    const tabKind = 'trading.chart'
    const sidebar = ctx.get('sidebarRight') as {
      openTab?(kind: string, options?: unknown): unknown
      isExpanded?(): boolean
      toggleExpanded?(): void
    } | undefined
    const tabs = ctx.get('sidebarRightTabs') as { register(definition: unknown): () => void } | undefined
    if (tabs === undefined) return
    // The pane resolves its body by the tab record's id OR its kind depending on how the
    // record was minted; claim both so either lookup finds us.
    const tabId = '@dsh-trading/client-chart/chart'
    ctx.slots.inject('sidebar.right.pane.tab', () => [tabKind, tabId].map(key =>
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab', key, registrant: '@dsh-trading/client-chart', inject: () => ({ market }) },
        SidebarChart,
      )))
    // A tab with no title renders as a blank chip: the label is its own keyed slot.
    ctx.slots.inject('sidebar.right.pane.tab.title', () => [tabKind, tabId].map(key =>
      ctx.slots.register(
        { name: 'sidebar.right.pane.tab.title', key, registrant: '@dsh-trading/client-chart' },
        ChartTabTitle,
      )))
    try {
      tabs.register({
        id: tabId,
        kind: tabKind,
        priority: 'builtin',
        title: () => 'Chart',
        // What the sidebar's "+" menu lists: without an entry the closed tab is
        // unreachable until the page reloads.
        guide: [{ id: tabId, kind: tabKind, title: () => 'Chart', description: () => 'Persistent chart column' }],
      })
    } catch (error) {
      console.warn('[client-chart] could not register the chart tab', error)
      return
    }
    // openTab refuses until a conversation surface is mounted, and dsh publishes no event
    // for that, so retry a bounded number of times before giving up.
    let remaining = 30
    let last = ''
    const open = (): void => {
      try {
        sidebar?.openTab?.(tabKind, { replaceTab: true })
        // A tab in a collapsed right bar is a tab nobody sees: ask for the column too.
        if (sidebar?.isExpanded?.() === false) sidebar.toggleExpanded?.()
        console.info('[client-chart] chart tab opened')
      } catch (error) {
        last = error instanceof Error ? error.message : String(error)
        if (remaining-- > 0) setTimeout(open, 2000)
        else console.warn('[client-chart] gave up opening the chart tab:', last)
      }
    }
    open()
  }
  // Services resolve lazily: this apply can run before the sidebar provides its registry.
  const injectDeps = (ctx as unknown as { inject?: (deps: string[], run: () => void) => void }).inject
  if (typeof injectDeps === 'function') injectDeps.call(ctx, ['sidebarRightTabs'], withTabs)
  else withTabs()

  ctx.slots.inject('trading.chart', () => [
    ctx.slots.register(
      {
        name: 'trading.chart',
        registrant: '@dsh-trading/client-chart',
        inject: (sessionId?: string) => ({
          market,
          ask: sessionId === undefined ? undefined : (text: string) => sendReply(ctx, sessionId, text),
        }),
      },
      ChartPanel,
    ),
  ])
}