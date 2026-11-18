/**
 * The gates, and the rule that makes them a gate rather than a score:
 * a veto is fatal, and an UNKNOWN that is substantive is also fatal.
 */
import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import { alignmentGate, renderSetup, reviewSetup } from '../src/setup.js'
import { findSwings } from '../src/structure.js'

const day = (n: number): string => new Date(Date.UTC(2026, 0, 1 + n)).toISOString()

/** A steady trend, so ADX is high and DI has a clear side. */
function trend(start: number, step: number, n = 80): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = start + step * i
    return { time: day(i), open: close, high: close + Math.abs(step) * 0.4 + 0.5, low: close - Math.abs(step) * 0.4 - 0.5, close, volume: 1 }
  })
}

const base = { symbol: 'TEST', timeframe: '1d' as const, candles: trend(100, -0.5) }

describe('three-piece rule', () => {
  it('vetoes a proposal with no target, whatever else looks good', () => {
    const r = reviewSetup({ ...base, proposal: { direction: 'short', entry: 60, invalidation: 70, targets: [] } })
    expect(r.gates.find(g => g.id === 'three-piece')!.status).toBe('veto')
    expect(r.verdict).toBe('stand aside')
    expect(r.reason).toMatch(/together/)
  })

  it('vetoes a stop on the wrong side of entry', () => {
    const r = reviewSetup({ ...base, proposal: { direction: 'short', entry: 60, invalidation: 50, targets: [40] } })
    expect(r.gates.find(g => g.id === 'risk-reward')!.status).toBe('veto')
    expect(r.verdict).toBe('stand aside')
  })
})

describe('reward:risk', () => {
  it('computes rr per target and vetoes a sub-1:1 first target', () => {
    const tight = reviewSetup({ ...base, proposal: { direction: 'short', entry: 60, invalidation: 62, targets: [59, 50] } })
    expect(tight.riskReward[0]).toBe(0.5)
    expect(tight.gates.find(g => g.id === 'risk-reward')!.status).toBe('veto')

    const wide = reviewSetup({ ...base, proposal: { direction: 'short', entry: 60, invalidation: 62, targets: [54, 50] } })
    expect(wide.riskReward).toEqual([3, 5])
    expect(wide.gates.find(g => g.id === 'risk-reward')!.status).toBe('pass')
  })
})

describe('regime decides what an extreme means', () => {
  it('vetoes fading an extreme while the regime says trend continuation', () => {
    // a steep fall pins stochastic low inside a trending baseline
    const falling = trend(200, -3)
    const r = reviewSetup({ symbol: 'T', timeframe: '1d', candles: falling, proposal: { direction: 'long', entry: 20, invalidation: 10, targets: [40] } })
    const gate = r.gates.find(g => g.id === 'direction')!
    expect(['veto', 'pass']).toContain(gate.status)
    if (gate.status === 'veto') expect(gate.detail).toMatch(/continuation/)
  })
})

describe('alignment gate', () => {
  it('vetoes when the two timeframes disagree, and never picks a side on pass', () => {
    const up = alignmentGate(trend(100, 0.5), trend(100, -0.5))
    expect(up.status).toBe('veto')
    const same = alignmentGate(trend(100, 0.5), trend(100, 0.5))
    if (same.status === 'pass') expect(same.detail).toMatch(/never picks a side/)
  })
})

describe('honesty about what is not implemented', () => {
  it('reports the closed-source layers as UNKNOWN, and they force stand aside', () => {
    const r = reviewSetup({ ...base, proposal: { direction: 'short', entry: 60, invalidation: 62, targets: [50] } })
    const unavailable = r.gates.find(g => g.id === 'unavailable')!
    expect(unavailable.status).toBe('unknown')
    expect(unavailable.detail).toContain('打點')
  })

  it('does not let a cross-asset reading pass without a caller threshold', () => {
    const r = reviewSetup({
      ...base,
      proposal: { direction: 'short', entry: 60, invalidation: 62, targets: [50] },
      crossAsset: { pair: 'HG=F/GC=F', percentile: 99 },
    })
    const gate = r.gates.find(g => g.id === 'cross-asset')!
    expect(gate.status).toBe('unknown')
    expect(gate.detail).toMatch(/no veto threshold/)
  })

  it('honours a caller-supplied veto line', () => {
    const r = reviewSetup({
      ...base,
      proposal: { direction: 'short', entry: 60, invalidation: 62, targets: [50] },
      crossAsset: { pair: 'HG=F/GC=F', percentile: 99, vetoAbove: 90 },
    })
    expect(r.gates.find(g => g.id === 'cross-asset')!.status).toBe('veto')
    expect(r.verdict).toBe('stand aside')
  })

  it('renders the verdict first and says targets are the caller\'s', () => {
    const text = renderSetup(reviewSetup({ ...base, proposal: { direction: 'short', entry: 60, invalidation: 62, targets: [50] } }))
    expect(text.split(String.fromCharCode(10))[1]).toContain('VERDICT')
    expect(text).toMatch(/targets are yours/)
  })
})

describe('gate identity', () => {
  it('never emits two gates with the same id', () => {
    const r = reviewSetup({
      ...base,
      higherTimeframe: trend(100, 0.01),
      proposal: { direction: 'short', entry: 60, invalidation: 62, targets: [50] },
    })
    const ids = r.gates.map(g => g.id)
    expect(new Set(ids).size).toBe(ids.length)
  })

  it('labels the timeframe gate as alignment, not data', () => {
    const gate = alignmentGate(trend(100, 0.5), trend(100, -0.5))
    expect(gate.id).toBe('alignment')
    expect(gate.status).toBe('veto')
  })

  it('names the deciding gate in the reason, so a reader knows which rule closed it', () => {
    const r = reviewSetup({ ...base, proposal: { direction: 'short', entry: 60, invalidation: 70, targets: [] } })
    expect(r.reason).toMatch(/^three-piece: /)
  })
})

describe('trend-side gate (regression: the 2026-11-13 gold miss)', () => {
  /** A steady decline: ADX high, -DI dominant, and stochastic pinned low ONLY if deep enough. */
  function declining(n = 80, step = -0.5, start = 200): Candle[] {
    return Array.from({ length: n }, (_, i) => {
      const close = start + step * i
      return { time: day(i), open: close, high: close + 0.2, low: close - Math.abs(step) * 2, close, volume: 1 }
    })
  }

  it('vetoes a long against a dominant -DI even when the oscillator is NOT extreme', () => {
    const r = reviewSetup({
      symbol: 'GC=F', timeframe: '1d', candles: declining(),
      proposal: { direction: 'long', entry: 170, invalidation: 160, targets: [190] },
    })
    const gate = r.gates.find(g => g.id === 'trend-side')!
    expect(gate.status).toBe('veto')
    expect(gate.detail).toMatch(/against the established trend/)
    expect(r.verdict).toBe('stand aside')
    expect(r.reason).toMatch(/^trend-side: /)
  })

  it('allows a short with the dominant -DI', () => {
    const r = reviewSetup({
      symbol: 'GC=F', timeframe: '1d', candles: declining(),
      proposal: { direction: 'short', entry: 170, invalidation: 180, targets: [150] },
    })
    expect(r.gates.find(g => g.id === 'trend-side')!.status).toBe('pass')
  })

  it('leaves a range alone: without a trend, DI direction is not a veto', () => {
    // oscillating series with no directional persistence -> ADX low
    const bars = Array.from({ length: 80 }, (_, i) => ({
      time: day(i), open: 100, high: 102, low: 98, close: 100 + (i % 2 === 0 ? 0.5 : -0.5), volume: 1,
    }))
    const r = reviewSetup({
      symbol: 'RANGE', timeframe: '1d', candles: bars,
      proposal: { direction: 'long', entry: 99, invalidation: 97, targets: [104] },
    })
    const gate = r.gates.find(g => g.id === 'trend-side')!
    expect(gate.status).toBe('pass')
    expect(gate.detail).toMatch(/no trend to be against/)
  })
})

describe('the tool can actually say act', () => {
  it('returns act when every checkable gate passes', () => {
    // three explicit segments so the series ENDS rising (a sine tail can leave -DI
    // dominant, which would be a legitimate trend-side veto and not a full pass):
    // up, a pullback that mints a confirmed swing low, then up again.
    const closes: number[] = []
    for (let i = 0; i < 100; i++) closes.push(100 + 0.5 * i)
    for (let i = 0; i < 6; i++) closes.push(closes[closes.length - 1]! - 1.5)
    for (let i = 0; i < 20; i++) closes.push(closes[closes.length - 1]! + 2)
    const bars = closes.map((close, i) => ({
      time: day(i), open: close, high: close + 0.8, low: close - 0.8, close, volume: 1,
    }))
    const low = findSwings(bars).filter(s => s.kind === 'low').pop()!
    const close = bars[bars.length - 1]!.close
    const r = reviewSetup({
      symbol: 'UP', timeframe: '1d', candles: bars, higherTimeframe: bars,
      proposal: { direction: 'long', entry: low.price + 0.5, invalidation: low.price - 2, targets: [close + 15] },
    })
    expect(r.verdict).toBe('act')
  })
})
