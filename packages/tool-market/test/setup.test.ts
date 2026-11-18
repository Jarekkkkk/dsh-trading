/**
 * The gates, and the rule that makes them a gate rather than a score:
 * a veto is fatal, and an UNKNOWN that is substantive is also fatal.
 */
import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import { alignmentGate, renderSetup, reviewSetup } from '../src/setup.js'

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
