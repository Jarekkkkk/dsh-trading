/**
 * Host half of the chart-card package. Three jobs, all small:
 *
 *  1. Give the profile's Loader row a plugin to mount, so the dsh web host
 *     scans the package's `dsh.client` manifest and serves the browser bundle.
 *  2. Publish a loopback RPC channel the persistent chart column reads from,
 *     so the user can put a symbol on the chart WITHOUT going through the
 *     model. See ./market-rpc.ts for why that matters.
 *  3. Report what that column is showing back to the model, as a per-turn
 *     context line and as the `get_chart_view` tool.
 *
 * Only (1) and (2) are web-only. Under a headless profile there is no
 * `connection` service, so the channel never appears — the row keeps loading
 * rather than failing, and (3) still registers, reporting a closed panel. The
 * channel is a web affordance, not a capability the rest of the bundle
 * depends on.
 * @module @dsh-trading/client-chart
 */

import type { Context } from '@deepseek-ai/cordis'
import type { HostConnectionHandle } from '@deepseek-ai/dsh-client-connection'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { ChartView, MarketDataLike } from './market-rpc.js'
import { describeChartView, ENDPOINTS, MARKET_CHANNEL, serveMarketEndpoint } from './market-rpc.js'

export {
  describeChartView,
  ENDPOINTS,
  MARKET_CHANNEL,
  MAX_PANEL_BARS,
  readChartView,
  readOhlcvRequest,
  serveMarketEndpoint,
} from './market-rpc.js'
export type { ChartView, MarketDataLike, OhlcvRequest, OhlcvResponse, SymbolsResponse } from './market-rpc.js'

export const name = 'client-chart'

/**
 * No top-level `inject`. `connection` is web-only, so declaring it as a hard
 * dependency would leave this row PENDING forever under a headless profile —
 * and a pending entry fails the whole boot. The runtime `ctx.inject` below
 * waits for both services instead: the row activates immediately, and the
 * channel appears if and when the web transport and a provider are mounted.
 */

/**
 * How long a published view stays believable.
 *
 * The store is one slot, and any browser on the loopback can write it — a
 * second tab left open on another symbol will clobber the one the user is
 * actually reading, and the model will then state the wrong instrument with
 * complete confidence. Neither read site (prompt assembly, tool execution)
 * carries a session id to key on, so freshness stands in for identity: a
 * panel that is genuinely being watched republishes on a heartbeat, and an
 * abandoned tab's claim simply expires. Saying nothing beats saying the wrong
 * symbol.
 */
const VIEW_TTL_MS = 30_000

export function apply(ctx: Context): void {
  // What the browser panel last reported it was showing, and when.
  let view: ChartView | undefined
  let viewAt = 0

  /** The view, if a panel is still actively reporting it. */
  const liveView = (): ChartView | undefined =>
    view !== undefined && Date.now() - viewAt <= VIEW_TTL_MS ? view : undefined

  // Typed locally rather than as ConnectionRpcHandler: that alias carries peer and
  // signal parameters the fetch route never has, and its arity moved between rcs.
  const makeHandler = (marketData: MarketDataLike) =>
    async (endpoint: string, payload: unknown): Promise<unknown> => {
    try {
      return {
        ok: true,
        value: await serveMarketEndpoint(marketData, endpoint, payload, next => {
          view = next
          viewAt = Date.now()
        }),
      }
    } catch (error) {
      // The panel shows this text verbatim, so it must read as guidance:
      // provider errors already name the symbol, the timeframe, or the OpenD
      // fix. Folding it into the error branch keeps the transport honest — a
      // failed lookup is not an empty chart.
      return {
        ok: false,
        error: { code: 'internal', message: error instanceof Error ? error.message : String(error), details: {} },
      }
    }
  }

  // The agent sits next to this chart but cannot see it: the panel's data path
  // deliberately bypasses the tool layer, so nothing about it reaches the
  // model on its own. Without this it asks the user for a screenshot of a
  // chart it is rendering. One line of context per turn fixes that; the tool
  // below carries the same facts for a model that wants them explicitly.
  ctx.inject(['systemPrompt'], scoped => {
    scoped.effect(() => scoped.systemPrompt.context({
      name: 'dsh-trading:chart-panel',
      order: 50,
      // Evaluated per assembly. Empty while no chart is up, and the prompt
      // layer treats empty text as no contribution — an idle panel is free.
      text: () => describeChartView(liveView()),
    }))
  })

  ctx.inject(['tools'], scoped => {
    scoped.effect(() => scoped.tools.register(defineTool({
      name: 'get_chart_view',
      description:
        "Read what the user's chart panel is currently displaying: symbol, timeframe, "
        + 'bar count, visible time span, last price, and whether it is refreshing live. '
        + 'Read-only. Use this instead of asking the user to describe or screenshot their chart.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            open: { type: 'boolean', required: true },
            symbol: { type: 'string' },
            timeframe: { type: 'string' },
            bars: { type: 'number' },
            from: { type: 'string' },
            to: { type: 'string' },
            close: { type: 'number' },
            live: { type: 'boolean' },
            origin: { type: 'string' },
            marks: { type: 'number' },
            marksDropped: { type: 'number' },
            marksTimeframe: { type: 'string' },
          },
        },
        render: (_args, value) => [{
          type: 'text',
          text: value.open
            ? `${value.symbol} @ ${value.timeframe} — ${value.bars} bars`
              + `${value.from !== undefined ? `, ${value.from} to ${value.to}` : ''}`
              + `${value.close !== undefined ? `, last ${value.close}` : ''}`
              + `, ${value.live === true ? 'live' : 'paused'} (${value.origin})`
              + `${value.marks !== undefined && value.marks > 0
                ? ` — your ${value.marks} marks from the ${value.marksTimeframe ?? ''} analysis are drawn`
                  + `${value.marksDropped !== undefined && value.marksDropped > 0 ? `, ${value.marksDropped} off-window` : ''}`
                : ''}`
            : 'The chart panel is empty — the user has not opened a chart.',
        }],
      },
      isConcurrencySafe: () => true,
      async execute() {
        const current = liveView()
        if (current === undefined) return { open: false }
        // Spread the optional fields conditionally: `exactOptionalPropertyTypes`
        // distinguishes "absent" from "present and undefined", and the tool
        // output schema wants the former.
        return {
          open: true,
          symbol: current.symbol,
          timeframe: current.timeframe,
          bars: current.bars,
          live: current.live,
          origin: current.origin,
          ...current.from !== undefined ? { from: current.from } : {},
          ...current.to !== undefined ? { to: current.to } : {},
          ...current.close !== undefined ? { close: current.close } : {},
          ...current.marks !== undefined ? { marks: current.marks } : {},
          ...current.marksDropped !== undefined ? { marksDropped: current.marksDropped } : {},
          ...current.marksTimeframe !== undefined ? { marksTimeframe: current.marksTimeframe } : {},
        }
      },
      presentCall: args => ({ card: 'generic', title: 'Read chart panel', kind: 'read', rawInput: args }),
    })))
  })

  ctx.inject(['connection', 'marketData'], scoped => {
    // Typed at the read rather than through declaration merging: this package
    // compiles with `types: []`, so the ambient `ctx.connection` augmentation
    // is not necessarily in scope here.
    const connection = scoped.get('connection') as HostConnectionHandle
    const marketData = scoped.get('marketData') as MarketDataLike

    // dsh 0.2.x: all RPC rides the shared /api channel. `rpc.handle(MARKET_CHANNEL)`
    // mounts a prefix route on a path the /api owner never forwards to (the panel
    // got HTTP 405), and `fetch.register(MARKET_CHANNEL/...)` is refused outright
    // ("invalid exact Fetch route" — exact routes must live under /api). The
    // sanctioned seam is what dsh's own gateway uses: `rpc.intercept('/api',`
    // claim the endpoints this plugin owns, and the handler answers them.
    const handle = makeHandler(marketData)
    const marketPrefix = 'dsh-trading-market'
    scoped.effect(() => {
      const dispose = (connection.rpc as unknown as {
        intercept?: (channel: string, matches: (endpoint: string) => boolean, handler: (endpoint: string, payload: unknown) => Promise<unknown>) => () => void
      }).intercept?.call(connection.rpc, '/api',
        endpoint => endpoint.startsWith(`${marketPrefix}/`),
        (endpoint, payload) => handle(endpoint.slice(marketPrefix.length + 1), payload))
      return () => {
        void dispose?.()
      }
    }, 'client-chart: market data channel')
  })
}
