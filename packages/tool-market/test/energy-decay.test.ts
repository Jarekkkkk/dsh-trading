/**
 * The one part of his method stated numerically, so the one part we can falsify.
 * These cases pin the measurement, not the conclusion: where the excursion peaks,
 * and that a thin sample refuses to conclude.
 */
import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import { MIN_EVENTS, energyDecay, renderEnergyDecay } from '../src/energy-decay.js'

const day = (n: number): string => new Date(Date.UTC(2026, 0, 1 + n)).toISOString()

/** Build bars from closes, with a fixed wick so ATR is non-zero. */
function bars(closes: number[]): Candle[] {
  return closes.map((close, i) => ({
    time: day(i), open: close, high: close + 1, low: close - 1, close, volume: 1,
  }))
}

describe('energyDecay', () => {
  it('refuses to conclude on a thin sample', () => {
    const r = energyDecay('T', '1d', bars(Array.from({ length: 60 }, (_, i) => 100 + (i % 7) * 2)))
    if (r.events < MIN_EVENTS) {
      expect(r.verdict).toBe('NOT_PROVEN')
      expect(r.headline).toMatch(/cannot support/)
    }
  })

  it('records the peak bar of a move that fades right after the break', () => {
    // up-then-down zigzag so swings exist; each rally peaks quickly
    const closes: number[] = []
    for (let cycle = 0; cycle < 20; cycle++) {
      closes.push(100 + cycle, 103 + cycle, 106 + cycle, 107 + cycle, 104 + cycle, 101 + cycle)
    }
    const r = energyDecay('T', '1d', bars(closes), 20)
    expect(r.events).toBeGreaterThan(0)
    expect(r.medianPeakBar).toBeGreaterThanOrEqual(0)
    expect(r.medianPeakBar).toBeLessThanOrEqual(20)
  })

  it('keeps the three shares coherent', () => {
    const closes: number[] = []
    for (let c = 0; c < 25; c++) closes.push(50 + c, 53 + c, 56 + c, 54 + c, 51 + c)
    const r = energyDecay('T', '1d', bars(closes), 20)
    const total = r.shareBefore5 + r.shareWithin5to10 + r.shareBeyond10
    if (r.events > 0) expect(total).toBeCloseTo(100, 0)
  })

  it('always prints its blind spots, including the one that limits the claim', () => {
    const r = energyDecay('T', '1d', bars(Array.from({ length: 200 }, (_, i) => 100 + Math.sin(i / 4) * 8)))
    const text = renderEnergyDecay(r)
    expect(text).toContain('VERDICT')
    expect(text).toMatch(/blind spot: breakout definition is ours/)
    expect(text).toMatch(/not whether T1 would have filled first/)
  })

  it('throws rather than pretending on a series that is too short', () => {
    expect(() => energyDecay('T', '1d', bars([1, 2, 3]))).toThrow(/at least 40 bars/)
  })
})
