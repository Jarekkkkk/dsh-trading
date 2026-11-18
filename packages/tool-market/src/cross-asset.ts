/**
 * Cross-asset relative-value maths.
 *
 * The corpus's largest single theme (66 of 189 posts) is 跨資產 — reading one
 * instrument *through* another: gold in silver, copper in gold, everything in
 * dollars. His stated design is a three-filter matrix (匯市 / 債市 / 商品) whose
 * job is **verification, not signals**: the cross-asset leg has a veto, never a
 * trigger. See docs/06 §6 of the research corpus.
 *
 * Two consequences shape this module:
 *
 *  - Ratios are only meaningful **within their own history**. 1.506 grams of gold
 *    per unit of copper says nothing until you know whether it is high or low for
 *    this pair, so every result carries a percentile of its own window.
 *  - Two instruments rarely share a calendar (futures holidays, weekend crypto),
 *    so legs are joined on **bar time**, never on index. A silent off-by-one here
 *    would shift one leg against the other and produce a ratio that looks fine.
 *
 * Pure functions, no I/O: the tool layer fetches, this module decides.
 * @module @dsh-trading/tool-market/cross-asset
 */

import type { Candle } from '@dsh-trading/market-data'

/** One leg of a comparison. */
export type Leg = { symbol: string; candles: readonly Candle[] }

/** Where the latest value sits inside its own window. */
export type RatioPoint = {
  /** ISO-8601 bar-open time both legs agreed on. */
  time: string
  /** numerator / denominator. */
  value: number
}

/** Full description of one relative-value reading. */
export type CrossAssetResult = {
  /** e.g. `HG=F/GC=F`, or just the symbol in level mode. */
  pair: string
  mode: 'ratio' | 'level'
  timeframe: string
  /** Bars that survived the join — the honest sample size. */
  bars: number
  /** Bars dropped because only one leg had them. */
  droppedBars: number
  from: string
  to: string
  /** Latest value of the ratio (or of the single leg). */
  latest: number
  first: number
  changePct: number
  /** Share of the window at or below `latest`, 0..100. */
  percentile: number
  min: number
  max: number
  /** True when the sample is too small for the percentile to mean anything. */
  thin: boolean
  /** Multiplier applied to the raw ratio before display (1 = none). */
  scale: number
}

/** Below this many joined bars a percentile is noise and must be labelled so. */
export const MIN_BARS_FOR_PERCENTILE = 30

/** Round to a fixed number of places, without -0. */
function round(value: number, places = 4): number {
  const scaled = Number(value.toFixed(places))
  return scaled === 0 ? 0 : scaled
}

/**
 * Join two legs on bar time and divide them.
 *
 * Only times present in BOTH legs survive. Futu and Yahoo disagree about
 * holidays, and crypto never closes, so an index-based join is silently wrong.
 * @param numerator - the leg being priced.
 * @param denominator - the leg doing the pricing; omit for level mode.
 * @returns the joined points, ascending, plus how many bars were dropped.
 */
export function joinLegs(
  numerator: Leg,
  denominator?: Leg,
): { points: RatioPoint[]; dropped: number } {
  const denom = denominator === undefined
    ? undefined
    : new Map(denominator.candles.map(c => [c.time, c.close]))
  const points: RatioPoint[] = []
  for (const bar of numerator.candles) {
    const other = denom === undefined ? 1 : denom.get(bar.time)
    // A missing time (or a zero denominator) is dropped rather than carried: the
    // sample size is part of the result, so the caller can see what was lost.
    if (other === undefined || other === 0) continue
    const value = bar.close / other
    if (!Number.isFinite(value)) continue
    points.push({ time: bar.time, value })
  }
  points.sort((a, b) => Date.parse(a.time) - Date.parse(b.time))
  // Count BAR-TIMES lost, not leg-bars: a slot only one leg had is one lost slot,
  // and a shared slot with an unusable divisor is also one — not two. The unit
  // matters because this number is what tells the reader how much the calendars
  // disagreed.
  const slots = new Set(numerator.candles.map(c => c.time))
  if (denominator !== undefined) for (const c of denominator.candles) slots.add(c.time)
  const dropped = slots.size - points.length
  return { points, dropped }
}

/**
 * Describe one ratio series: latest, change over the window, and where the
 * latest value sits in its own history.
 * @param pairs - joined points, ascending.
 * @param pair - display name for the pair.
 * @param mode - ratio or level.
 * @param timeframe - the interval both legs were read on.
 * @returns the reading, with `thin` set when the sample cannot support a percentile.
 */
export function describeCrossAsset(
  points: readonly RatioPoint[],
  pair: string,
  mode: 'ratio' | 'level',
  timeframe: string,
  /**
   * Display multiplier for the ratio. Copper-in-gold is 0.0015, which nobody can
   * read; x1000 gives 1.506. Carried in the result and printed with the number, so
   * a scaled figure can never be mistaken for the raw one.
   */
  scale = 1,
): CrossAssetResult {
  if (points.length === 0) {
    throw new Error(`${pair}: the two legs share no bar times — nothing to compare`)
  }
  const values = points.map(p => p.value * scale)
  const latest = values[values.length - 1]!
  const first = values[0]!
  const below = values.filter(v => v <= latest).length
  return {
    pair,
    mode,
    timeframe,
    bars: points.length,
    droppedBars: 0,
    from: points[0]!.time,
    to: points[points.length - 1]!.time,
    latest: round(latest),
    first: round(first),
    changePct: first === 0 ? 0 : round(((latest - first) / first) * 100, 2),
    percentile: round((below / values.length) * 100, 1),
    min: round(Math.min(...values)),
    max: round(Math.max(...values)),
    thin: points.length < MIN_BARS_FOR_PERCENTILE,
    scale,
  }
}

/**
 * The one-line reading the model sees.
 *
 * States the sample size and the window on every line: a percentile without
 * "of how many bars, over what span" is the exact kind of number this project
 * refuses to put in front of a reader.
 * @param result - a completed reading.
 * @returns a compact multi-line block.
 */
export function renderCrossAsset(result: CrossAssetResult): string {
  const thin = result.thin
    ? ` — THIN SAMPLE (${result.bars} bars, under ${MIN_BARS_FOR_PERCENTILE}): percentile not meaningful`
    : ''
  const scaled = result.scale === 1 ? '' : ` (x${result.scale})`
  const relation = `${result.pair} = ${result.latest}${scaled}`
  return [
    `${relation} @ ${result.timeframe} · ${result.bars} joined bars (${result.from} → ${result.to})${thin}`,
    `  change ${result.changePct > 0 ? '+' : ''}${result.changePct}% over the window | percentile ${result.percentile} of ${result.bars} | range ${result.min} … ${result.max}`,
    '  cross-asset is a VETO in this framework, not a trigger: a stretched ratio can stay stretched.',
  ].join('\n')
}
