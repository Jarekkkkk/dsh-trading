/**
 * The four-colour classifier, pinned to the quadrant table the author published:
 * trend+OB=red, trend+OS=green, range+OB=yellow, range+OS=blue, with a silent
 * state for every non-extreme bar (the alarm is meant to be quiet most of the time).
 */
import { describe, expect, it } from 'vitest'
import { REGIME_DEFAULTS, regimeLabel, regimeReading } from '../src/regime-color.js'

const A = REGIME_DEFAULTS

describe('regimeReading', () => {
  it('marks trend + overbought as red (continuation, not a turn)', () => {
    const r = regimeReading(85, 30, A)
    expect(r.color).toBe('red')
    expect(r.baseline).toBe('trend')
    expect(r.extreme).toBe('overbought')
    expect(r.meaning).toContain('continuation')
  })

  it('marks trend + oversold as green (continuation downward, not a buy)', () => {
    const r = regimeReading(12, 30, A)
    expect(r.color).toBe('green')
    expect(r.extreme).toBe('oversold')
    expect(r.meaning).toContain('continuation')
  })

  it('marks range + overbought as yellow (mean reversion)', () => {
    const r = regimeReading(85, 15, A)
    expect(r.color).toBe('yellow')
    expect(r.baseline).toBe('range')
    expect(r.meaning).toContain('mean-reversion')
  })

  it('marks range + oversold as blue (mean reversion)', () => {
    const r = regimeReading(10, 15, A)
    expect(r.color).toBe('blue')
    expect(r.meaning).toContain('mean-reversion')
  })

  it('stays silent between the extreme bands, still reporting the baseline', () => {
    const r = regimeReading(50, 30, A)
    expect(r.color).toBeNull()
    expect(r.baseline).toBe('trend')
    expect(r.meaning).toContain('alarm silent')
  })

  it('treats the thresholds as inclusive, and ADX 20 as trend', () => {
    expect(regimeReading(80, 20, A).color).toBe('red')
    expect(regimeReading(20, 20, A).color).toBe('green')
    expect(regimeReading(80, 19.99, A).color).toBe('yellow')
    expect(regimeReading(19.99, 20, A).color).toBe('green')
  })

  it('handles a missing reading without inventing a colour', () => {
    const r = regimeReading(null, 30, A)
    expect(r.color).toBeNull()
    expect(r.extreme).toBeNull()
    expect(regimeLabel(r)).toBe('silent (trend)')
  })

  it('labels a fired state with baseline and extreme', () => {
    expect(regimeLabel(regimeReading(10, 30, A))).toBe('green (trend · oversold)')
  })
})
