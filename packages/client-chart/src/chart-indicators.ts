/**
 * Host-only chart enrichment: the regime snapshot and per-bar series the panel's
 * indicator chips and panes read.
 *
 * Kept in its own module on purpose. `market-rpc.ts` is imported by the BROWSER
 * bundle (it exports the channel name and request validators), so pulling the
 * indicator library in there would ship `tool-market`'s node-side code to the
 * client. This file is reached only from the package's host entry.
 *
 * The maths is the model's own: the same `regimeSnapshot` / `regimeSeries` the
 * tools use, so a chip on the panel and a number in the analysis cannot disagree.
 * @module @dsh-trading/client-chart/chart-indicators
 */
import type { Candle } from '@dsh-trading/market-data'
import { chartSeries, regimeSeries, regimeSnapshot } from '@dsh-trading/tool-market'

/** What the panel needs beyond candles to draw its chips and panes. */
export interface ChartEnrichment {
  indicators: unknown
  series: Record<string, (number | null)[]>
}

/**
 * Compute the regime snapshot and the per-bar series for one candle window.
 * @param candles - the same bars the payload carries, ascending.
 * @returns the enrichment to merge into the timeframe.
 */
export function enrichChart(candles: readonly Candle[]): ChartEnrichment {
  return {
    indicators: regimeSnapshot(candles),
    // Capped to THIS window, not to the chart-card default: the panel draws every
    // bar it fetched (1000), and a chip is only clickable when its series column
    // has exactly one value per candle (hasSeries compares lengths).
    series: chartSeries(regimeSeries(candles), candles.length),
  }
}
