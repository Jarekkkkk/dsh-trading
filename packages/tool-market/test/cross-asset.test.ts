/**
 * The join and the reading. Two things here are load-bearing: legs are matched on
 * bar TIME (never index — futures and crypto keep different calendars), and a
 * percentile is refused when the sample is too small to carry one.
 */
import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import { MIN_BARS_FOR_PERCENTILE, describeCrossAsset, joinLegs, renderCrossAsset } from '../src/cross-asset.js'

const day = (n: number): string => new Date(Date.UTC(2026, 0, n)).toISOString()
const bar = (n: number, close: number): Candle => ({
  time: day(n), open: close, high: close, low: close, close, volume: 1,
})

describe('joinLegs', () => {
  it('divides on matching times only', () => {
    const { points } = joinLegs(
      { symbol: 'A', candles: [bar(1, 10), bar(2, 20)] },
      { symbol: 'B', candles: [bar(1, 2), bar(2, 4)] },
    )
    expect(points.map(p => p.value)).toEqual([5, 5])
  })

  it('drops and COUNTS the times one leg is missing (never shifts by index)', () => {
    const { points, dropped } = joinLegs(
      { symbol: 'A', candles: [bar(1, 10), bar(2, 20), bar(3, 30)] },
      { symbol: 'B', candles: [bar(1, 2), bar(3, 6)] },
    )
    expect(points.map(p => p.time)).toEqual([day(1), day(3)])
    expect(points.map(p => p.value)).toEqual([5, 5])
    // one numerator bar (day 2) unmatched, and the denominator had no extra bars
    expect(dropped).toBe(1)
  })

  it('counts both sides when the denominator has extra bars', () => {
    const { points, dropped } = joinLegs(
      { symbol: 'A', candles: [bar(1, 10)] },
      { symbol: 'B', candles: [bar(1, 2), bar(2, 9), bar(3, 9)] },
    )
    expect(points).toHaveLength(1)
    expect(dropped).toBe(2)
  })

  it('treats a zero denominator as unusable rather than dividing by it', () => {
    const { points, dropped } = joinLegs(
      { symbol: 'A', candles: [bar(1, 10), bar(2, 20)] },
      { symbol: 'B', candles: [bar(1, 0), bar(2, 4)] },
    )
    expect(points.map(p => p.value)).toEqual([5])
    expect(dropped).toBe(1)
  })

  it('reads a single leg as level mode by defaulting the divisor to 1', () => {
    const { points } = joinLegs({ symbol: 'A', candles: [bar(1, 10), bar(2, 12)] })
    expect(points.map(p => p.value)).toEqual([10, 12])
  })
})

describe('describeCrossAsset', () => {
  const series = (values: number[]) => values.map((v, i) => ({ time: day(i + 1), value: v }))

  it('reports the percentile of the latest value inside its own window', () => {
    const r = describeCrossAsset(series([1, 2, 3, 4, 5]), 'X/Y', 'ratio', '1d')
    expect(r.latest).toBe(5)
    expect(r.first).toBe(1)
    expect(r.changePct).toBe(400)
    expect(r.percentile).toBe(100)
    expect(r.bars).toBe(5)
  })

  it('does not clamp the percentile to a comfortable middle', () => {
    const r = describeCrossAsset(series([5, 4, 3, 2, 1]), 'X/Y', 'ratio', '1d')
    expect(r.percentile).toBe(20)
  })

  it('flags a thin sample instead of quietly reporting a percentile', () => {
    const r = describeCrossAsset(series(Array.from({ length: MIN_BARS_FOR_PERCENTILE - 1 }, (_, i) => i + 1)), 'X/Y', 'ratio', '1d')
    expect(r.thin).toBe(true)
    const ok = describeCrossAsset(series(Array.from({ length: MIN_BARS_FOR_PERCENTILE }, (_, i) => i + 1)), 'X/Y', 'ratio', '1d')
    expect(ok.thin).toBe(false)
  })

  it('refuses an empty join rather than inventing a value', () => {
    expect(() => describeCrossAsset([], 'X/Y', 'ratio', '1d')).toThrow(/share no bar times/)
  })

  it('scales the display and says so, so a scaled number cannot pass as raw', () => {
    const points = [0.0015, 0.0016].map((v, i) => ({ time: day(i + 1), value: v }))
    const raw = describeCrossAsset(points, 'HG=F/GC=F', 'ratio', '1d')
    const scaled = describeCrossAsset(points, 'HG=F/GC=F', 'ratio', '1d', 1000)
    // latest is the LAST point, not the first
    expect(raw.latest).toBe(0.0016)
    expect(scaled.latest).toBe(1.6)
    expect(renderCrossAsset(scaled)).toContain('(x1000)')
    expect(renderCrossAsset(raw)).not.toContain('(x')
  })

  it('renders the sample size, the window and the veto reminder', () => {
    const text = renderCrossAsset(describeCrossAsset(series([1, 2, 3]), 'HG=F/GC=F', 'ratio', '1d'))
    expect(text).toContain('HG=F/GC=F = 3')
    expect(text).toContain('3 joined bars')
    expect(text).toContain('VETO')
    expect(text).toContain('THIN SAMPLE')
  })
})
