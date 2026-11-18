/**
 * Every declared output field must exist, and every field that is returned must be
 * declared. This is a text-level guard on purpose: the tool schemas are object
 * literals inside apply(), and two tools already shipped a mismatch that only the
 * runtime caught (cross_asset lost from/to/first/min/max, judge_setup lost close).
 * A missing declaration makes the tool unusable while every unit test still passes,
 * so the check belongs at the seam between the module and its registered schema.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import type { Candle } from '@dsh-trading/market-data'
import { describeCrossAsset, joinLegs } from '../src/cross-asset.js'
import { structureReport } from '../src/structure.js'
import { energyDecay } from '../src/energy-decay.js'
import { reviewSetup } from '../src/setup.js'

const source = readFileSync(new URL('../src/index.ts', import.meta.url), 'utf8')

/** Property keys declared in one tool's output schema. */
function declaredKeys(toolName: string): string[] {
  const at = source.indexOf(`name: '${toolName}'`)
  if (at < 0) throw new Error(`tool ${toolName} not found in index.ts`)
  const next = source.indexOf('ctx.tools.register(', at + 1)
  const block = source.slice(at, next < 0 ? undefined : next)
  return [...block.matchAll(/\n {10}([a-zA-Z][a-zA-Z0-9]*): \{ type:/g)].map(m => m[1]!)
}

/** Bars with a real high/low spread so ATR and swings are non-degenerate. */
function candles(n = 120): Candle[] {
  return Array.from({ length: n }, (_, i) => {
    const close = 100 + Math.sin(i / 5) * 6 + i * 0.05
    return {
      time: new Date(Date.UTC(2026, 0, 1 + i)).toISOString(),
      open: close, high: close + 1.2, low: close - 1.2, close, volume: 1,
    }
  })
}

describe('declared tool schemas cover what the tools return', () => {
  it('judge_setup', () => {
    const review = reviewSetup({
      symbol: 'T', timeframe: '1d', candles: candles(),
      proposal: { direction: 'short', entry: 100, invalidation: 104, targets: [92] },
    })
    const returned = [...Object.keys(review), 'text']
    expect(declaredKeys('judge_setup').sort()).toEqual(returned.sort())
  })

  it('cross_asset', () => {
    const bars = candles()
    const { points } = joinLegs({ symbol: 'A', candles: bars }, { symbol: 'B', candles: bars })
    const result = describeCrossAsset(points, 'A/B', 'ratio', '1d')
    // describeCrossAsset already carries droppedBars (as 0); the tool overwrites it
    // with the real count, so dedupe rather than listing it twice.
    const returned = [...new Set([...Object.keys(result), 'text'])]
    expect(declaredKeys('cross_asset').sort()).toEqual(returned.sort())
  })

  it('market_structure', () => {
    const report = structureReport(candles(), '1d')
    const returned = ['symbol', 'timeframe', 'close', 'resistance', 'support', 'failedBreak', 'text']
    expect(declaredKeys('market_structure').sort()).toEqual(returned.sort())
    expect(report.close).toBeGreaterThan(0)
  })

  it('audit_energy_decay', () => {
    const result = energyDecay('T', '1d', candles(200))
    const returned = [...Object.keys(result), 'text']
    expect(declaredKeys('audit_energy_decay').sort()).toEqual(returned.sort())
  })
})
