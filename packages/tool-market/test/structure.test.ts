/**
 * Structure is the layer entries and stops come from, so three properties matter
 * more than any others: a swing is only knowable in hindsight (never in the last
 * N bars), a break is a CLOSE and not a wick, and every level says how it was found.
 */
import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import {
  findFailedBreak,
  findSwings,
  nearestLevels,
  renderStructure,
  structureReport,
  windowOf,
} from '../src/structure.js'

/** Build bars from a close path, with wicks given explicitly when needed. */
function series(closes: number[], highPad = 0, lowPad = 0): Candle[] {
  return closes.map((close, i) => ({
    time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
    open: close,
    high: close + highPad,
    low: close - lowPad,
    close,
    volume: 1,
  }))
}

describe('findSwings', () => {
  it('finds a pivot high and a pivot low in a clear zigzag', () => {
    const swings = findSwings(series([1, 2, 3, 2, 1, 2, 3]), 1, 1)
    expect(swings.filter(s => s.kind === 'high').map(s => s.price)).toContain(3)
    expect(swings.filter(s => s.kind === 'low').map(s => s.price)).toContain(1)
  })

  it('never reports a swing inside the final right-bars window — that would be lookahead', () => {
    const swings = findSwings(series([1, 2, 3, 2, 1]), 1, 1)
    for (const s of swings) expect(s.barsAgo).toBeGreaterThanOrEqual(1)
    expect(swings.some(s => s.barsAgo === 0)).toBe(false)
  })

  it('requires BOTH sides to be lower, so a rising series has no swing high', () => {
    expect(findSwings(series([1, 2, 3, 4, 5, 6, 7]), 1, 1).filter(s => s.kind === 'high')).toHaveLength(0)
  })
})

describe('nearestLevels', () => {
  it('picks the closest level on each side, with distance and source', () => {
    const swings = [
      { kind: 'high' as const, index: 2, time: '2026-01-03T00:00:00.000Z', price: 105, barsAgo: 5 },
      { kind: 'high' as const, index: 6, time: '2026-01-07T00:00:00.000Z', price: 103, barsAgo: 1 },
      { kind: 'low' as const, index: 4, time: '2026-01-05T00:00:00.000Z', price: 97, barsAgo: 3 },
      { kind: 'low' as const, index: 1, time: '2026-01-02T00:00:00.000Z', price: 95, barsAgo: 6 },
    ]
    const { resistance, support } = nearestLevels(swings, 100)
    expect(resistance!.price).toBe(103)
    expect(resistance!.distancePct).toBe(3)
    expect(resistance!.source).toContain('swing high')
    expect(support!.price).toBe(97)
    expect(support!.distancePct).toBe(-3)
  })

  it('returns null rather than a zero-distance level when the swing sits at the close', () => {
    const swings = [{ kind: 'high' as const, index: 1, time: '2026-01-02T00:00:00.000Z', price: 100, barsAgo: 1 }]
    expect(nearestLevels(swings, 100).resistance).toBeNull()
  })
})

describe('windowOf', () => {
  it('reports a positive slope for a rising window and a negative one for falling', () => {
    expect(windowOf(series([1, 2, 3, 4]), 4)!.slopePerBar).toBeGreaterThan(0)
    expect(windowOf(series([4, 3, 2, 1]), 4)!.slopePerBar).toBeLessThan(0)
  })

  it('expresses width and slope against the close, so instruments compare', () => {
    const w = windowOf(series([100, 101, 102], 5, 5), 3)!
    expect(w.widthPct).toBeGreaterThan(0)
    expect(Math.abs(w.slopePctPerBar)).toBeLessThan(100)
  })
})

describe('findFailedBreak', () => {
  // Two shapes of failure, both real: a wick that never held (same bar), and a
  // break that held for a bar then gave way. The first has barsOutside 0.
  it('counts a same-bar wick rejection as a failed break, with zero bars outside', () => {
    const candles: Candle[] = [
      { time: '2026-01-01T00:00:00.000Z', open: 98, high: 99, low: 97, close: 98, volume: 1 },
      { time: '2026-01-02T00:00:00.000Z', open: 98, high: 100, low: 97, close: 99, volume: 1 },
      { time: '2026-01-03T00:00:00.000Z', open: 99, high: 99.5, low: 98, close: 98.5, volume: 1 },
      { time: '2026-01-04T00:00:00.000Z', open: 99, high: 101, low: 98.5, close: 99.5, volume: 1 },
      { time: '2026-01-05T00:00:00.000Z', open: 99, high: 99, low: 96, close: 96.5, volume: 1 },
    ]
    const swings = [{ kind: 'high' as const, index: 1, time: candles[1]!.time, price: 100, barsAgo: 3 }]
    const failed = findFailedBreak(candles, swings, 3)
    expect(failed).not.toBeNull()
    expect(failed!.level).toBe(100)
    expect(failed!.piercedTime).toBe(candles[3]!.time)
    expect(failed!.rejectedTime).toBe(candles[3]!.time)
    expect(failed!.barsOutside).toBe(0)
  })

  it('counts a break that held one bar then failed as barsOutside 1', () => {
    const candles: Candle[] = [
      { time: '2026-01-01T00:00:00.000Z', open: 98, high: 99, low: 97, close: 98, volume: 1 },
      { time: '2026-01-02T00:00:00.000Z', open: 98, high: 100, low: 97, close: 99, volume: 1 },
      { time: '2026-01-03T00:00:00.000Z', open: 99, high: 99.5, low: 98, close: 98.5, volume: 1 },
      { time: '2026-01-04T00:00:00.000Z', open: 99, high: 102, low: 99, close: 101, volume: 1 },
      { time: '2026-01-05T00:00:00.000Z', open: 101, high: 101, low: 96, close: 96.5, volume: 1 },
    ]
    const swings = [{ kind: 'high' as const, index: 1, time: candles[1]!.time, price: 100, barsAgo: 3 }]
    const failed = findFailedBreak(candles, swings, 3)
    expect(failed!.piercedTime).toBe(candles[3]!.time)
    expect(failed!.rejectedTime).toBe(candles[4]!.time)
    expect(failed!.barsOutside).toBe(1)
  })

  it('does not call a clean breakout a failure', () => {
    const candles: Candle[] = [
      { time: '2026-01-01T00:00:00.000Z', open: 98, high: 99, low: 97, close: 98, volume: 1 },
      { time: '2026-01-02T00:00:00.000Z', open: 98, high: 100, low: 97, close: 99, volume: 1 },
      { time: '2026-01-03T00:00:00.000Z', open: 99, high: 101, low: 98, close: 100.5, volume: 1 },
      { time: '2026-01-04T00:00:00.000Z', open: 100, high: 103, low: 99, close: 102, volume: 1 },
      { time: '2026-01-05T00:00:00.000Z', open: 102, high: 104, low: 101, close: 103, volume: 1 },
    ]
    const swings = [{ kind: 'high' as const, index: 1, time: candles[1]!.time, price: 100, barsAgo: 3 }]
    expect(findFailedBreak(candles, swings, 3)).toBeNull()
  })
})
describe('structureReport', () => {
  it('refuses a series too short to hold a swing', () => {
    expect(() => structureReport(series([1, 2, 3]), '1d')).toThrow(/at least 5 bars/)
  })

  it('renders every level with its source and claims no projection', () => {
    const closes = Array.from({ length: 40 }, (_, i) => 100 + Math.sin(i / 3) * 5)
    const text = renderStructure(structureReport(series(closes), '1d'))
    expect(text).toContain('swing')
    expect(text).toContain('fractals')
    expect(text).not.toMatch(/target/i)
  })
})