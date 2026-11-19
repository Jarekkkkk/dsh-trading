/**
 * A price channel, computed rather than drawn.
 *
 * The fit is a **linear regression channel**: regress close on bar index, then place
 * the rails at a fixed number of standard deviations of the residuals. Three reasons
 * this beats connecting pivots by eye:
 *
 *  1. **Every bar votes.** Pivot-based channels turn on which two points a person
 *     picked; a regression uses the whole window.
 *  2. **The rails follow the fit.** An earlier version of this file put rails at the
 *     extreme swing residuals, which is parallel but anchored to old pivots: after a
 *     break it printed "position -78%" for copper and "no channel" for everything
 *     else. Sigma bands move with the regression, so the geometry stays meaningful
 *     and `positionPct` stays readable.
 *  3. **R-squared says whether a channel exists at all.** A channel is a claim that
 *     price travels in a direction; R² measures that claim directly, so a series
 *     chopping sideways is reported as unfittable instead of getting two confident
 *     lines nobody could trade.
 *
 * Width here means `railWidthPct` (2 sigma as a percent of close), which CAN change
 * between fits — so narrowing is measured against the preceding window of equal
 * length, not inside one fit.
 * @module @dsh-trading/tool-market/channel
 */

import type { Candle } from '@dsh-trading/market-data'
import { atr } from './candle-indicators.js'
import { findSwings } from './structure.js'

/** A close outside the rails, and whether it came back. */
export type ChannelBreak = {
  time: string
  side: 'upper' | 'lower'
  /** True when price closed back inside within the grace window. */
  failed: boolean
  /** Bars spent outside before returning, or null when it never returned. */
  barsOutside: number | null
}

/** The fitted channel, or the reason it could not be fitted. */
export type Channel = {
  status: 'ok' | 'insufficient'
  reason: string | null
  bars: number
  /** Least-squares slope of close on bar index, price per bar. */
  slopePerBar: number
  slopePctPerBar: number
  /** Coefficient of determination: how much of the path the direction explains. */
  r2: number
  /** Rails at the last bar (midline plus and minus RAIL_SIGMA standard deviations). */
  upper: number
  mid: number
  lower: number
  /** One standard deviation of the residuals, in price. */
  sigma: number
  /** Rail-to-rail width as a percent of the close. */
  widthPct: number
  /** Where the close sits: 0 = lower rail, 100 = upper. May fall outside. */
  positionPct: number
  /** Confirmed swings landing near each rail, out of those inside the window. */
  upperTouches: number
  lowerTouches: number
  swingsInWindow: number
  /** ATR at the last bar, for sizing the channel against volatility. */
  atr: number | null
  /** Width versus the preceding window of the same length; null when unavailable. */
  narrowing: boolean | null
  priorWidthPct: number | null
  /** Recent rail breaks, most recent last. */
  breaks: ChannelBreak[]
}

/** Window used when the caller does not choose one. */
export const DEFAULT_CHANNEL_BARS = 120
/** Rail distance from the midline, in standard deviations of the residuals. */
export const RAIL_SIGMA = 2
/** Minimum R² before the fit counts as a channel rather than noise. */
export const MIN_R2 = 0.3
/** Bars a break may stay outside before it counts as held. */
export const BREAK_GRACE_BARS = 3
/** A swing counts as touching a rail when its residual is at least this many sigma. */
export const TOUCH_SIGMA = 1.2

const emptyChannel = (bars: number, reason: string): Channel => ({
  status: 'insufficient', reason, bars, slopePerBar: 0, slopePctPerBar: 0, r2: 0,
  upper: 0, mid: 0, lower: 0, sigma: 0, widthPct: 0, positionPct: 0,
  upperTouches: 0, lowerTouches: 0, swingsInWindow: 0, atr: null,
  narrowing: null, priorWidthPct: null, breaks: [],
})

/**
 * Fit a regression channel over the last `bars` candles.
 * @param candles - ascending bars.
 * @param options - window length, rail width in sigma, break grace.
 * @returns the channel, or `status: 'insufficient'` with the reason.
 */
export function channelOf(
  candles: readonly Candle[],
  options: { bars?: number; sigma?: number; grace?: number; minR2?: number } = {},
): Channel {
  const bars = Math.min(options.bars ?? DEFAULT_CHANNEL_BARS, candles.length)
  const k = options.sigma ?? RAIL_SIGMA
  const grace = options.grace ?? BREAK_GRACE_BARS
  const minR2 = options.minR2 ?? MIN_R2
  if (candles.length < 30) return emptyChannel(bars, 'fewer than 30 bars: a channel needs history to describe')

  const window = candles.slice(candles.length - bars)
  const n = window.length
  const xs = window.map((_, i) => i)
  const ys = window.map(c => c.close)
  const meanX = (n - 1) / 2
  const meanY = ys.reduce((a, b) => a + b, 0) / n
  let sxy = 0
  let sxx = 0
  for (let i = 0; i < n; i++) {
    sxy += (xs[i]! - meanX) * (ys[i]! - meanY)
    sxx += (xs[i]! - meanX) ** 2
  }
  if (sxx === 0) return emptyChannel(bars, 'degenerate window')
  const slope = sxy / sxx
  const intercept = meanY - slope * meanX

  const residuals = ys.map((y, i) => y - (slope * xs[i]! + intercept))
  const ssRes = residuals.reduce((a, r) => a + r * r, 0)
  const ssTot = ys.reduce((a, y) => a + (y - meanY) ** 2, 0)
  const r2 = ssTot === 0 ? 0 : 1 - ssRes / ssTot
  const sigma = Math.sqrt(ssRes / n)
  if (r2 < minR2) {
    return {
      ...emptyChannel(
        bars,
        `no channel: R² ${r2.toFixed(2)} is under ${minR2} over ${bars} bars, so the path has no direction to channel — this is a range, not a channel`,
      ),
      r2: Number(r2.toFixed(3)),
    }
  }

  const lastIndex = n - 1
  const mid = slope * lastIndex + intercept
  const upper = mid + k * sigma
  const lower = mid - k * sigma
  const close = candles[candles.length - 1]!.close
  const width = upper - lower
  const atrSeries = atr(candles)
  const atrNow = atrSeries[atrSeries.length - 1] ?? null

  const swings = findSwings(window)
  let upperTouches = 0
  let lowerTouches = 0
  for (const s of swings) {
    const residual = s.price - (slope * s.index + intercept)
    if (residual >= TOUCH_SIGMA * sigma) upperTouches += 1
    if (-residual >= TOUCH_SIGMA * sigma) lowerTouches += 1
  }

  const scanFrom = Math.max(0, n - 60)
  const breaks: ChannelBreak[] = []
  for (let i = scanFrom; i <= lastIndex; i++) {
    const u = slope * i + intercept + k * sigma
    const l = slope * i + intercept - k * sigma
    const c = window[i]!.close
    const side = c > u ? 'upper' : c < l ? 'lower' : null
    if (side === null) continue
    let outside: number | null = null
    for (let j = i + 1; j <= Math.min(lastIndex, i + grace); j++) {
      const cj = window[j]!.close
      if (side === 'upper' ? cj <= u : cj >= l) { outside = j - i; break }
    }
    breaks.push({ time: window[i]!.time, side, failed: outside !== null, barsOutside: outside })
  }

  // Sigma bands can breathe between fits, so narrowing is a comparison, not a property.
  let priorWidthPct: number | null = null
  if (candles.length >= bars * 2) {
    const prior = channelOf(candles.slice(0, candles.length - bars), { bars, sigma: k, grace, minR2 })
    if (prior.status === 'ok') priorWidthPct = prior.widthPct
  }
  const widthPct = Number(((width / close) * 100).toFixed(2))

  return {
    status: 'ok',
    reason: null,
    bars,
    slopePerBar: Number(slope.toFixed(6)),
    slopePctPerBar: Number(((slope / close) * 100).toFixed(5)),
    r2: Number(r2.toFixed(3)),
    upper: Number(upper.toFixed(4)),
    mid: Number(mid.toFixed(4)),
    lower: Number(lower.toFixed(4)),
    sigma: Number(sigma.toFixed(4)),
    widthPct,
    positionPct: Number((((close - lower) / width) * 100).toFixed(1)),
    upperTouches,
    lowerTouches,
    swingsInWindow: swings.length,
    atr: atrNow === null ? null : Number(atrNow.toFixed(4)),
    narrowing: priorWidthPct === null ? null : widthPct < priorWidthPct,
    priorWidthPct,
    breaks: breaks.slice(-4),
  }
}

/**
 * Render a channel as the block a reader checks.
 * @param c - a fitted channel.
 * @param close - the latest close, so position reads against a named price.
 * @returns multi-line text.
 */
export function renderChannel(c: Channel, close: number): string {
  if (c.status !== 'ok') return `channel: not fitted — ${c.reason ?? 'unknown reason'}`
  const where = c.positionPct < 0 ? `BELOW the lower rail (${c.positionPct}%)`
    : c.positionPct > 100 ? `ABOVE the upper rail (${c.positionPct}%)`
      : `${c.positionPct}% up the channel`
  const atrLine = c.atr === null ? '' : ` | channel width = ${(Number(c.widthPct) / 100 * close / c.atr).toFixed(2)} ATR`
  return [
    `channel over ${c.bars} bars (R² ${c.r2}): close ${close} sits ${where}`,
    `  rails at this bar: lower ${c.lower} | mid ${c.mid} | upper ${c.upper} | width ${c.widthPct}% of close (±${c.sigma})${atrLine}`,
    `  slope ${c.slopePerBar}/bar (${c.slopePctPerBar}%/bar) | swings near rails: upper ${c.upperTouches}, lower ${c.lowerTouches} of ${c.swingsInWindow}`,
    c.narrowing === null
      ? '  width trend: unknown (no prior window of the same length)'
      : `  width vs the prior ${c.bars} bars: ${c.narrowing ? 'NARROWING' : 'widening or equal'} (${c.priorWidthPct}% -> ${c.widthPct}%)`,
    ...(c.breaks.length === 0
      ? ['  no rail close in the last 60 bars']
      : c.breaks.map(b => `  close outside ${b.side} rail on ${b.time.slice(0, 10)}: ${b.failed ? `failed (back inside after ${b.barsOutside} bars)` : 'held'}`)),
  ].join('\n')
}
