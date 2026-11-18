/**
 * Testing his one quantified claim instead of repeating it.
 *
 * From the corpus (docs/06 §3, quoting him): after price breaks a key level it
 * releases its strongest energy within **5-10 bars, rarely more than 10**, and
 * then decays — which is why T1 is "the sweet spot of probability, payoff and
 * size".
 *
 * That is the only part of his method stated numerically, so it is the only part
 * we can falsify. Everything else (channel, 打點, 選美) is closed-source and stays
 * unverified rather than assumed.
 *
 * The test is deliberately boring and reproducible:
 *
 *  1. find confirmed fractal swings (3 bars each side — no lookahead),
 *  2. take the first bar that CLOSES beyond a swing (a break, not a wick),
 *  3. measure, over a fixed horizon, where the maximum favourable excursion peaks,
 *  4. report that distribution and let it speak.
 *
 * The verdict is tri-state and allowed to be NOT_PROVEN: with fewer than 30 events
 * the sample cannot support any conclusion, and saying so is more useful than a
 * percentage computed from nine bars.
 * @module @dsh-trading/tool-market/energy-decay
 */

import type { Candle } from '@dsh-trading/market-data'
import { atr } from './candle-indicators.js'
import { findSwings } from './structure.js'

/** One breakout event and where its move peaked. */
export type DecayEvent = {
  /** Date price closed beyond the level. */
  time: string
  /** 'up' = broke a swing high, 'down' = broke a swing low. */
  direction: 'up' | 'down'
  /** The level that broke. */
  level: number
  /** Entry price: that bar's close. */
  entry: number
  /** Bars from entry until the excursion peaked (0 = the breakout bar itself). */
  peakBar: number
  /** Largest favourable move, in ATR multiples at entry. */
  peakAtr: number
}

/** The claim's verdict, allowed to be honest about a thin sample. */
export type DecayVerdict = 'SUPPORTED' | 'NOT_SUPPORTED' | 'NOT_PROVEN'

/** Full result of the test. */
export type EnergyDecayResult = {
  symbol: string
  timeframe: string
  bars: number
  horizon: number
  /** Events that qualified. */
  events: number
  medianPeakBar: number
  meanPeakBar: number
  /** Share of events peaking within bars 5-10 inclusive. */
  shareWithin5to10: number
  /** Share peaking after bar 10 — the part his claim says is rare. */
  shareBeyond10: number
  /** Share peaking before bar 5. */
  shareBefore5: number
  medianPeakAtr: number
  verdict: DecayVerdict
  /** One line anyone can check. */
  headline: string
  /** What this test cannot see. */
  blindSpots: string[]
}

/** Events needed before any verdict is defensible. */
export const MIN_EVENTS = 30
/** Bars to look forward for the excursion peak. */
export const DEFAULT_HORIZON = 20

/**
 * Run the decay test over one series.
 * @param symbol - label echoed into the result.
 * @param timeframe - label echoed into the result.
 * @param candles - ascending bars.
 * @param horizon - forward bars to measure.
 * @returns events, distribution and verdict.
 */
export function energyDecay(
  symbol: string,
  timeframe: string,
  candles: readonly Candle[],
  horizon = DEFAULT_HORIZON,
): EnergyDecayResult {
  if (candles.length < 40) throw new Error('energy-decay test needs at least 40 bars')
  const swings = findSwings(candles)
  const atrSeries = atr(candles)
  const last = candles.length - 1
  const events: DecayEvent[] = []

  for (const swing of swings) {
    // First bar that CLOSES beyond the level, scanning forward from the swing.
    for (let i = swing.index + 1; i <= last; i++) {
      const bar = candles[i]!
      const broke = swing.kind === 'high' ? bar.close > swing.price : bar.close < swing.price
      if (!broke) continue
      const atEntry = atrSeries[i]
      if (atEntry === undefined || atEntry === null || atEntry === 0) break
      const entry = bar.close
      const limit = Math.min(last, i + horizon)
      let best = 0
      let peakBar = 0
      let peakAtr = 0
      for (let j = i; j <= limit; j++) {
        const forward = candles[j]!
        const excursion = swing.kind === 'high' ? forward.high - entry : entry - forward.low
        if (excursion > best) {
          best = excursion
          peakBar = j - i
          peakAtr = excursion / atEntry
        }
      }
      events.push({
        time: bar.time,
        direction: swing.kind === 'high' ? 'up' : 'down',
        level: swing.price,
        entry,
        peakBar,
        peakAtr: Number(peakAtr.toFixed(2)),
      })
      break
    }
  }

  const peakBars = events.map(e => e.peakBar).sort((a, b) => a - b)
  const peakAtrs = events.map(e => e.peakAtr).sort((a, b) => a - b)
  const median = (xs: number[]): number => xs.length === 0 ? 0 : (xs.length % 2 === 1 ? xs[(xs.length - 1) / 2]! : (xs[xs.length / 2 - 1]! + xs[xs.length / 2]!) / 2)
  const share = (predicate: (bar: number) => boolean): number =>
    peakBars.length === 0 ? 0 : Number(((peakBars.filter(predicate).length / peakBars.length) * 100).toFixed(1))

  const shareWithin5to10 = share(b => b >= 5 && b <= 10)
  const shareBeyond10 = share(b => b > 10)
  const shareBefore5 = share(b => b < 5)

  // The claim has two halves: "most of it inside bars 5-10" AND "rarely beyond 10".
  // Both are tested; a sample that satisfies neither is evidence against the claim,
  // not an absence of evidence — that is the difference between NOT_SUPPORTED and
  // NOT_PROVEN, and it took real data (44.6% peaking after bar 10 on 379 gold
  // breaks) to see it.
  const verdict: DecayVerdict = events.length < MIN_EVENTS
    ? 'NOT_PROVEN'
    : shareWithin5to10 >= 50
      ? 'SUPPORTED'
      : shareBeyond10 >= 40
        ? 'NOT_SUPPORTED'
        : 'NOT_PROVEN'

  const headline = events.length < MIN_EVENTS
    ? `${events.length} events is under ${MIN_EVENTS}: the sample cannot support any claim about where the energy decays`
    : `${events.length} breaks: ${shareWithin5to10}% peaked inside bars 5-10, ${shareBeyond10}% after bar 10, ${shareBefore5}% before bar 5 (median peak bar ${median(peakBars)})`

  return {
    symbol, timeframe, bars: candles.length, horizon,
    events: events.length,
    medianPeakBar: median(peakBars),
    meanPeakBar: peakBars.length === 0 ? 0 : Number((peakBars.reduce((a, b) => a + b, 0) / peakBars.length).toFixed(2)),
    shareWithin5to10,
    shareBeyond10,
    shareBefore5,
    medianPeakAtr: Number(median(peakAtrs).toFixed(2)),
    verdict,
    headline,
    blindSpots: [
      'breakout definition is ours (close beyond a 3/3 fractal swing), not his',
      'one instrument, one timeframe: results do not transfer',
      'the horizon caps the measurement, so a peak after it is counted as the horizon',
      'this tests where the move peaked, not whether T1 would have filled first',
    ],
  }
}

/**
 * Render the result.
 * @param r - a completed test.
 * @returns the verdict, the distribution and the blind spots, in that order.
 */
export function renderEnergyDecay(r: EnergyDecayResult): string {
  return [
    `${r.symbol} @ ${r.timeframe} · ${r.bars} bars · horizon ${r.horizon} bars`,
    `VERDICT: ${r.verdict} — ${r.headline}`,
    `  median peak at bar ${r.medianPeakBar} (mean ${r.meanPeakBar}) · median excursion ${r.medianPeakAtr} ATR`,
    ...r.blindSpots.map(b => `  blind spot: ${b}`),
  ].join('\n')
}
