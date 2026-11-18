/**
 * Market structure: the swing points, the range, and the break that failed.
 *
 * This is the layer his framework builds entries and stops from — "找出可以被否證
 * 的價位" — and the corpus's dominant vocabulary is exactly this: 突破 (253 hits)
 * and 结构 (244). It is the one perceptual layer we had no support for at all, so
 * every "where is the prior low" question was answered by an agent counting bars.
 *
 * Three rules keep it honest:
 *
 *  1. **Every level carries its source.** A swing needs `left`/`right` bars on both
 *     sides that did not exceed it — a fractal, not a line drawn by eye. The level
 *     object reports the bar, the date, how many bars it has held, and how far the
 *     price is from it, because "support at 3700" without those is an opinion.
 *  2. **A break is a close, not a wick.** Piercing a level intrabar and closing back
 *     inside is the 假突破 he warns about; conflating the two is how a failed break
 *     gets read as a breakout.
 *  3. **Nothing is projected.** No targets, no measured moves. This module locates
 *     structure that already printed.
 * @module @dsh-trading/tool-market/structure
 */

import type { Candle } from '@dsh-trading/market-data'

/** A confirmed fractal swing. */
export type Swing = {
  /** 'high' = a pivot high (resistance side), 'low' = a pivot low. */
  kind: 'high' | 'low'
  /** Bar index in the series handed in. */
  index: number
  time: string
  price: number
  /** Bars elapsed since this swing printed (0 = the most recent bar). */
  barsAgo: number
}

/** A level the reader can point at, with the evidence that produced it. */
export type StructureLevel = {
  kind: 'high' | 'low'
  price: number
  time: string
  barsAgo: number
  /** Signed distance from the latest close, in percent. */
  distancePct: number
  /** One line naming exactly how this level was found. */
  source: string
}

/** A level that was pierced and then rejected. */
export type FailedBreak = {
  level: number
  /** Date the level itself printed. */
  levelTime: string
  /** Date price first traded beyond the level. */
  piercedTime: string
  /** Date the series closed back on the original side. */
  rejectedTime: string
  /** Bars spent outside before the rejection. */
  barsOutside: number
  kind: 'high' | 'low'
}

/** Range and slope over one lookback. */
export type Window = {
  bars: number
  high: number
  low: number
  /** Range width as a percentage of the latest close. */
  widthPct: number
  /** Least-squares slope per bar, in price units. */
  slopePerBar: number
  /** The same slope as a percentage of the latest close per bar. */
  slopePctPerBar: number
}

/** Everything the structure layer knows about one series. */
export type StructureReport = {
  timeframe: string
  bars: number
  lastTime: string
  close: number
  /** Nearest confirmed swing above and below the close, when one exists. */
  resistance: StructureLevel | null
  support: StructureLevel | null
  /** Windows his method reads: 20 short, 50 medium, 100 long. */
  windows: Window[]
  /** Most recent failed breakout, if the series shows one. */
  failedBreak: FailedBreak | null
  /** Newest confirmed swing, for orientation. */
  latestSwing: Swing | null
}

/** Bars required on each side of a pivot before it counts as a swing. */
export const DEFAULT_SWING_LEFT = 3
export const DEFAULT_SWING_RIGHT = 3
/** Windows used for range and slope, mirroring 20/50/100 in his step 2. */
export const DEFAULT_WINDOWS = [20, 50, 100] as const

/**
 * Find confirmed fractal swings.
 *
 * A pivot high needs `left` bars before it and `right` bars after it whose highs
 * are all strictly lower. The right side is why a swing is only knowable in
 * hindsight: the last `right` bars can never contain one, and pretending
 * otherwise is how a chart grows a level that was never tested.
 * @param candles - ascending bars.
 * @param left - bars required lower on the left.
 * @param right - bars required lower on the right.
 * @returns swings ascending by index.
 */
export function findSwings(
  candles: readonly Candle[],
  left = DEFAULT_SWING_LEFT,
  right = DEFAULT_SWING_RIGHT,
): Swing[] {
  const out: Swing[] = []
  const last = candles.length - 1
  for (let i = left; i <= last - right; i++) {
    const bar = candles[i]!
    let isHigh = true
    let isLow = true
    for (let j = i - left; j <= i + right; j++) {
      if (j === i) continue
      const other = candles[j]!
      if (other.high >= bar.high) isHigh = false
      if (other.low <= bar.low) isLow = false
      if (!isHigh && !isLow) break
    }
    if (isHigh) out.push({ kind: 'high', index: i, time: bar.time, price: bar.high, barsAgo: last - i })
    else if (isLow) out.push({ kind: 'low', index: i, time: bar.time, price: bar.low, barsAgo: last - i })
  }
  return out
}

/**
 * Pick the nearest swing level on each side of the close.
 *
 * A swing exactly at the close is not a level to lean on: it is where price is, so
 * it is skipped rather than reported as zero distance.
 * @param swings - confirmed swings.
 * @param close - latest close.
 * @returns the nearest confirmed level above and below, with its provenance.
 */
export function nearestLevels(
  swings: readonly Swing[],
  close: number,
): { resistance: StructureLevel | null; support: StructureLevel | null } {
  const describe = (s: Swing): StructureLevel => ({
    kind: s.kind,
    price: s.price,
    time: s.time,
    barsAgo: s.barsAgo,
    distancePct: Number((((s.price - close) / close) * 100).toFixed(2)),
    source: `${s.kind === 'high' ? 'swing high' : 'swing low'} ${s.time.slice(0, 10)}, printed ${s.barsAgo} bars ago`,
  })
  const above = swings.filter(s => s.kind === 'high' && s.price > close).sort((a, b) => a.price - b.price)
  const below = swings.filter(s => s.kind === 'low' && s.price < close).sort((a, b) => b.price - a.price)
  return {
    resistance: above.length === 0 ? null : describe(above[0]!),
    support: below.length === 0 ? null : describe(below[0]!),
  }
}

/**
 * Range width and least-squares slope over one window.
 *
 * The slope is reported in price units per bar AND as a percentage of the close,
 * because "1.4 per bar" means nothing without knowing whether the instrument is
 * gold at 3,700 or copper at 5.6.
 * @param candles - ascending bars.
 * @param bars - window length; clamped to what exists.
 * @returns the window, or null when there are not enough bars.
 */
export function windowOf(candles: readonly Candle[], bars: number): Window | null {
  if (candles.length < 2 || bars < 2) return null
  const slice = candles.slice(Math.max(0, candles.length - bars))
  if (slice.length < 2) return null
  const closes = slice.map(c => c.close)
  const close = closes[closes.length - 1]!
  const n = closes.length
  const meanX = (n - 1) / 2
  const meanY = closes.reduce((a, b) => a + b, 0) / n
  let num = 0
  let den = 0
  for (let i = 0; i < n; i++) {
    num += (i - meanX) * (closes[i]! - meanY)
    den += (i - meanX) ** 2
  }
  const slopePerBar = den === 0 ? 0 : num / den
  const high = Math.max(...slice.map(c => c.high))
  const low = Math.min(...slice.map(c => c.low))
  return {
    bars: n,
    high,
    low,
    widthPct: Number((((high - low) / close) * 100).toFixed(2)),
    slopePerBar: Number(slopePerBar.toFixed(4)),
    slopePctPerBar: Number(((slopePerBar / close) * 100).toFixed(4)),
  }
}

/**
 * Find the most recent failed break.
 *
 * A failed break is: price traded beyond a confirmed swing, then closed back on
 * the original side within `withinBars`. This is his 假突破 / 跌破失敗 — the setup he
 * treats as a reversal candidate rather than a continuation.
 * @param candles - ascending bars.
 * @param swings - confirmed swings to test.
 * @param withinBars - how quickly the close must return to count as failed.
 * @returns the newest failed break, or null.
 */
export function findFailedBreak(
  candles: readonly Candle[],
  swings: readonly Swing[],
  withinBars = 3,
): FailedBreak | null {
  const last = candles.length - 1
  let found: FailedBreak | null = null
  // Newest swing first: a reader asking "did the last break fail" wants the most
  // recent event, not the earliest one in the series that happens to match.
  for (const swing of [...swings].sort((a, b) => b.index - a.index)) {
    if (found !== null) break
    for (let i = swing.index + 1; i <= last; i++) {
      const bar = candles[i]!
      const beyond = swing.kind === 'high' ? bar.high > swing.price : bar.low < swing.price
      if (!beyond) continue
      // Walk forward to the first close back on the original side.
      let rejected = -1
      for (let j = i; j <= Math.min(last, i + withinBars); j++) {
        const close = candles[j]!.close
        const back = swing.kind === 'high' ? close < swing.price : close > swing.price
        if (back) { rejected = j; break }
      }
      if (rejected === -1) break
      found = {
        level: swing.price,
        levelTime: swing.time,
        piercedTime: bar.time,
        rejectedTime: candles[rejected]!.time,
        barsOutside: rejected - i,
        kind: swing.kind,
      }
      break
    }
  }
  return found
}

/**
 * Assemble the full structure report.
 * @param candles - ascending bars.
 * @param timeframe - the interval, echoed into the report.
 * @param options - window list and swing width.
 * @returns the report, or a throw when there are too few bars to say anything.
 */
export function structureReport(
  candles: readonly Candle[],
  timeframe: string,
  options: { windows?: readonly number[]; left?: number; right?: number; withinBars?: number } = {},
): StructureReport {
  if (candles.length < 5) throw new Error('structure needs at least 5 bars')
  const swings = findSwings(candles, options.left ?? DEFAULT_SWING_LEFT, options.right ?? DEFAULT_SWING_RIGHT)
  const lastBar = candles[candles.length - 1]!
  const close = lastBar.close
  const { resistance, support } = nearestLevels(swings, close)
  const windows = (options.windows ?? DEFAULT_WINDOWS)
    .map(w => windowOf(candles, w))
    .filter((w): w is Window => w !== null)
  return {
    timeframe,
    bars: candles.length,
    lastTime: lastBar.time,
    close,
    resistance,
    support,
    windows,
    failedBreak: findFailedBreak(candles, swings, options.withinBars ?? 3),
    latestSwing: swings.length === 0 ? null : swings[swings.length - 1]!,
  }
}

/**
 * Render the report as the compact block the model reads.
 * @param r - a structure report.
 * @returns multi-line text, every level naming its own source.
 */
export function renderStructure(r: StructureReport): string {
  const pct = (v: number): string => `${v > 0 ? '+' : ''}${v}%`
  const level = (l: StructureLevel | null, label: string): string =>
    l === null ? `  ${label}: none confirmed` : `  ${label}: ${l.price} (${pct(l.distancePct)}) — ${l.source}`
  const windows = r.windows
    .map(w => `  range(${w.bars}) ${w.low} … ${w.high} (width ${w.widthPct}% of close) | slope ${w.slopePerBar}/bar (${w.slopePctPerBar}%/bar)`)
    .join('\n')
  const failed = r.failedBreak === null
    ? '  failed break: none in this window'
    : r.failedBreak.barsOutside === 0
      // Same bar: a wick that never held. 'after 0 bars' reads like a bug.
      ? `  failed break: wicked through ${r.failedBreak.level} on ${r.failedBreak.piercedTime.slice(0, 10)} and closed back inside the same bar`
      : `  failed break: broke ${r.failedBreak.level} on ${r.failedBreak.piercedTime.slice(0, 10)}, held ${r.failedBreak.barsOutside} bar(s), closed back on ${r.failedBreak.rejectedTime.slice(0, 10)}`
  return [
    `${r.timeframe} · ${r.bars} bars, last ${r.lastTime}, close ${r.close}`,
    level(r.resistance, 'resistance'),
    level(r.support, 'support'),
    windows,
    failed,
    '  levels are confirmed fractals (3 bars each side), not lines drawn by eye.',
  ].join('\n')
}
