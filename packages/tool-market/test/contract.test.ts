/**
 * Contract identity. The bug these prevent: on 2026-11-19 CL=F silently rolled from
 * December to January, its label still said December, and a price level minted on one
 * contract was quoted against the other.
 */
import { describe, expect, it } from 'vitest'
import {
  MONTH_CODES,
  candidateMonths,
  continuousRoot,
  contractSymbol,
  exchangesFor,
  isContinuous,
  lastRoll,
  matchContract,
  monthLabel,
} from '../src/contract.js'

describe('isContinuous / continuousRoot', () => {
  it('recognises the =F form and nothing else', () => {
    expect(isContinuous('CL=F')).toBe(true)
    expect(isContinuous('GC=F')).toBe(true)
    expect(isContinuous('CLF27.NYM')).toBe(false)
    expect(isContinuous('QQQ')).toBe(false)
  })

  it('extracts the root', () => {
    expect(continuousRoot('CL=F')).toBe('CL')
    expect(continuousRoot('6E=F')).toBe('6E')
    expect(continuousRoot('CLF27.NYM')).toBeNull()
  })
})

describe('candidateMonths / contractSymbol', () => {
  it('walks across a year boundary', () => {
    const months = candidateMonths(new Date(Date.UTC(2026, 10, 19)), 4)
    expect(months.map(m => monthLabel(m))).toEqual(['Nov 2026', 'Dec 2026', 'Jan 2027', 'Feb 2027'])
  })

  it('builds the CME symbol the way the venue names it', () => {
    const months = candidateMonths(new Date(Date.UTC(2026, 11, 1)), 2)
    expect(contractSymbol('CL', months[0]!, '.NYM')).toBe('CLZ26.NYM')
    expect(contractSymbol('CL', months[1]!, '.NYM')).toBe('CLF27.NYM')
    expect(MONTH_CODES).toHaveLength(12)
  })

  it('knows which venue to try per root, and falls back for unknown ones', () => {
    expect(exchangesFor('CL')).toContain('.NYM')
    expect(exchangesFor('GC')).toContain('.CMX')
    expect(exchangesFor('ZZZ').length).toBeGreaterThan(1)
  })
})

describe('matchContract', () => {
  it('picks the month whose price agrees, ignoring the label entirely', () => {
    const hit = matchContract(83.33, [
      { symbol: 'CLZ26.NYM', close: 84.28 },
      { symbol: 'CLF27.NYM', close: 83.34 },
    ])
    expect(hit!.symbol).toBe('CLF27.NYM')
    expect(hit!.diffPct).toBeLessThan(0.05)
  })

  it('refuses to name a contract when no month is close enough', () => {
    expect(matchContract(83.33, [{ symbol: 'CLZ26.NYM', close: 84.28 }])).toBeNull()
  })

  it('never divides by a non-positive price', () => {
    expect(matchContract(0, [{ symbol: 'X', close: 1 }])).toBeNull()
    expect(matchContract(10, [{ symbol: 'X', close: 0 }])).toBeNull()
  })
})

describe('lastRoll', () => {
  it('finds the most recent switch, not the first one', () => {
    const roll = lastRoll(
      ['A', 'A', 'B', 'B', 'C', 'C'],
      ['d1', 'd2', 'd3', 'd4', 'd5', 'd6'],
    )
    expect(roll).toEqual({ date: 'd5', from: 'B', to: 'C' })
  })

  it('reports no roll when the match never changed', () => {
    expect(lastRoll(['A', 'A', 'A'], ['d1', 'd2', 'd3'])).toBeNull()
  })

  it('ignores unmatched days rather than treating them as a switch', () => {
    expect(lastRoll(['A', null, 'A'], ['d1', 'd2', 'd3'])).toBeNull()
  })
})
