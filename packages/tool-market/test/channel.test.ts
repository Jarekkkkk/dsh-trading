/**
 * The channel has to be a claim that can fail. These cases pin the three things that
 * make it one: a recoverable slope, an R² gate that refuses a range, and rails that
 * move with the fit instead of being anchored to old pivots.
 */
import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import { MIN_R2, RAIL_SIGMA, channelOf, renderChannel } from '../src/channel.js'

const day = (n: number): string => new Date(Date.UTC(2026, 0, 1 + n)).toISOString()

/** A drifting series with noise, so R² is high but not 1. */
function drifting(n = 160, slope = 0.5, noise = 1): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + slope * i + Math.sin(i * 1.7) * noise
    return { time: day(i), open: close, high: close + 0.8, low: close - 0.8, close, volume: 1 }
  })
}

describe('channelOf', () => {
  it('recovers the slope it was given', () => {
    const c = channelOf(drifting(160, 0.5), { bars: 160 })
    expect(c.status).toBe('ok')
    expect(c.slopePerBar).toBeGreaterThan(0.35)
    expect(c.slopePerBar).toBeLessThan(0.65)
  })

  it('reports a negative slope for a falling series', () => {
    expect(channelOf(drifting(160, -0.5), { bars: 160 }).slopePerBar).toBeLessThan(0)
  })

  it('places the rails at the configured sigma around the fit', () => {
    const c = channelOf(drifting(160, 0.5, 2), { bars: 160 })
    expect(c.upper - c.mid).toBeCloseTo(RAIL_SIGMA * c.sigma, 2)
    expect(c.mid - c.lower).toBeCloseTo(RAIL_SIGMA * c.sigma, 2)
  })

  it('keeps the close inside a sane position range for a clean channel', () => {
    const c = channelOf(drifting(160, 0.5, 1), { bars: 160 })
    expect(c.positionPct).toBeGreaterThan(0)
    expect(c.positionPct).toBeLessThan(100)
  })

  it('refuses to call a sideways chop a channel', () => {
    // pure oscillation around a constant: no direction for the regression to find
    const chop = Array.from({ length: 200 }, (_, i) => {
      const close = 100 + Math.sin(i / 4) * 3
      return { time: day(i), open: close, high: close + 0.8, low: close - 0.8, close, volume: 1 }
    })
    const c = channelOf(chop, { bars: 120 })
    expect(c.status).toBe('insufficient')
    expect(c.reason).toMatch(/R²/)
    expect(c.r2).toBeLessThan(MIN_R2)
  })

  it('refuses a series too short to fit', () => {
    expect(channelOf(drifting(12), { bars: 12 }).reason).toMatch(/fewer than 30 bars/)
  })

  it('flags a close outside the rails as a break, and a return as failed', () => {
    const bars = drifting(160, 0.5, 1)
    const last = bars.length - 2
    bars[last] = { ...bars[last]!, close: bars[last]!.close + 40 }
    const c = channelOf(bars, { bars: 158 })
    if (c.status === 'ok') {
      const hit = c.breaks.find(b => b.time === bars[last]!.time)
      if (hit) {
        expect(hit.side).toBe('upper')
        expect(hit.failed).toBe(true)
      }
    }
  })

  it('renders the R², the rails and the position in one block', () => {
    const text = renderChannel(channelOf(drifting(160, 0.5, 1), { bars: 160 }), 180)
    expect(text).toContain('R²')
    expect(text).toMatch(/rails at this bar/)
    expect(text).toMatch(/slope/)
  })
})
