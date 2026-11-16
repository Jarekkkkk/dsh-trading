/**
 * The chips are clickable only while every indicator column has exactly one value
 * per bar (hasSeries compares lengths), and the live tail changes that length on
 * every bar close. These cases pin the alignment rule.
 */
import { describe, expect, it } from 'vitest'
import { alignSeries } from '../src/client/market-client.js'

describe('alignSeries', () => {
  it('leaves an already-aligned column untouched, by identity', () => {
    const column = [1, 2, 3]
    const out = alignSeries({ rsi14: column }, 3)
    expect(out!['rsi14']).toBe(column)
  })

  it('pads a grown series at the END, so old values stay on their own bars', () => {
    const out = alignSeries({ rsi14: [1, 2, 3] }, 5)
    expect(out!['rsi14']).toEqual([1, 2, 3, null, null])
  })

  it('trims an over-long series from the front', () => {
    const out = alignSeries({ rsi14: [1, 2, 3, 4] }, 2)
    expect(out!['rsi14']).toEqual([3, 4])
  })

  it('passes an absent series through', () => {
    expect(alignSeries(undefined, 4)).toBeUndefined()
  })

  it('aligns every column, including an empty one', () => {
    const out = alignSeries({ adx: [1], plus_di: [] }, 2)
    expect(out!['adx']).toEqual([1, null])
    expect(out!['plus_di']).toEqual([null, null])
  })
})
