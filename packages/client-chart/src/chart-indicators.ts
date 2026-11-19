/**
 * Host-only chart enrichment: the regime snapshot, the per-bar series, and the
 * structure/channel geometry the panel's two overlay chips draw.
 *
 * Kept in its own module on purpose. `market-rpc.ts` is imported by the BROWSER
 * bundle (it exports the channel name and request validators), so pulling the
 * indicator library in there would ship `tool-market`'s node-side code to the
 * client. This file is reached only from the package's host entry.
 *
 * Every number here is the model's own: the same `regimeSnapshot` / `structureReport` /
 * `channelOf` the tools run, on the SAME candles the panel is drawing. Because the
 * host enriches per timeframe, switching the timeframe recomputes both chips.
 * @module @dsh-trading/client-chart/chart-indicators
 */
import type { Candle } from '@dsh-trading/market-data'
import { channelOf, chartSeries, regimeSeries, regimeSnapshot, structureReport } from '@dsh-trading/tool-market'

/** What the panel needs beyond candles to draw its chips and panes. */
export interface ChartEnrichment {
  indicators: unknown
  series: Record<string, (number | null)[]>
}

/**
 * Windows the panel channel tries, longest first.
 *
 * A single fixed window is wrong for the panel: it fetches ~1000 bars, and a 120-bar
 * regression of a market that has spent four months ranging then broken gives R² 0.01,
 * so the chip would read "no channel" on every instrument that is actually trending on
 * a shorter horizon. The first window with a real fit wins, and the chosen length is
 * carried into the label so the reader knows what the rails describe.
 */
const CHIP_CHANNEL_WINDOWS = [120, 60, 40] as const

/** Geometry the structure chip draws: two levels and the last failed break. */
function structureChip(candles: readonly Candle[]): unknown {
  if (candles.length < 5) return { unavailable: 'fewer than 5 bars' }
  try {
    const report = structureReport(candles, 'chart')
    return {
      resistance: report.resistance === null ? null : { price: report.resistance.price, distancePct: report.resistance.distancePct, barsAgo: report.resistance.barsAgo },
      support: report.support === null ? null : { price: report.support.price, distancePct: report.support.distancePct, barsAgo: report.support.barsAgo },
      failedBreak: report.failedBreak === null ? null : { level: report.failedBreak.level, time: report.failedBreak.piercedTime },
    }
  } catch {
    return { unavailable: 'structure could not be computed' }
  }
}

/**
 * Geometry the channel chip draws. A regression channel's rails are straight, so two
 * endpoints per rail are enough for the client to draw them.
 */
function channelChip(candles: readonly Candle[]): unknown {
  let channel = channelOf(candles, { bars: Math.min(CHIP_CHANNEL_WINDOWS[0], candles.length) })
  let reason = channel.reason
  for (const window of CHIP_CHANNEL_WINDOWS.slice(1)) {
    if (channel.status === 'ok') break
    if (candles.length < window) continue
    channel = channelOf(candles, { bars: window })
    reason = channel.reason ?? reason
  }
  if (channel.status !== 'ok') return { status: channel.status, reason }
  const bars = channel.bars
  const first = candles[candles.length - bars]!
  const last = candles[candles.length - 1]!
  const span = bars - 1
  return {
    status: channel.status,
    r2: channel.r2,
    bars,
    slopePerBar: channel.slopePerBar,
    positionPct: channel.positionPct,
    widthPct: channel.widthPct,
    // Rail price at the window's first bar: rail(t0) = rail(now) - slope * span.
    upperStart: Number((channel.upper - channel.slopePerBar * span).toFixed(6)),
    upperEnd: channel.upper,
    lowerStart: Number((channel.lower - channel.slopePerBar * span).toFixed(6)),
    lowerEnd: channel.lower,
    firstTime: first.time,
    lastTime: last.time,
  }
}

/**
 * Compute the snapshot, the per-bar series and the two chip geometries for one window.
 * @param candles - the same bars the payload carries, ascending.
 * @returns the enrichment to merge into the timeframe.
 */
export function enrichChart(candles: readonly Candle[]): ChartEnrichment {
  return {
    indicators: {
      ...(regimeSnapshot(candles) as Record<string, unknown>),
      structure: structureChip(candles),
      channel: channelChip(candles),
    },
    // Capped to THIS window, not to the chart-card default: the panel draws every
    // bar it fetched (1000), and a chip is only clickable when its series column
    // has exactly one value per candle (hasSeries compares lengths).
    series: chartSeries(regimeSeries(candles), candles.length),
  }
}
