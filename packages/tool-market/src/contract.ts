/**
 * Contract identity for continuous futures symbols.
 *
 * A continuous series like `CL=F` is not one instrument: it is a splice of front
 * months, re-stitched at each roll. Two failures follow, and both happened here:
 *
 *  1. **Price levels stop being comparable across a roll.** A swing high minted on
 *     the December contract is about 0.95 USD away from the January contract's
 *     price for the same moment. Quoting "resistance 84.61" against a January price
 *     of 83.70 therefore mixes two instruments — the distance is silently wrong.
 *  2. **A roll gap looks like a move that never happened.** On 2026-11-19 CL=F
 *     switched from CLZ26 to CLF27. Both contracts rose ~1.22% that day; the spliced
 *     series printed +0.07%, and an earlier intraday read showed the sign flipped.
 *
 * So the series' own label cannot be trusted either: the provider still called CL=F
 * "Crude Oil Dec 26" while it already tracked January. The only reliable answer comes
 * from comparing the continuous close against the named contracts themselves, which
 * is what this module does.
 * @module @dsh-trading/tool-market/contract
 */

/** CME month codes, January through December. */
export const MONTH_CODES = 'FGHJKMNQUVXZ'

/** Month names for the codes, in the same order. */
const MONTH_NAMES = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']

/** Exchange suffixes to try per root, most specific first. */
const ROOT_EXCHANGES: Record<string, readonly string[]> = {
  CL: ['.NYM'],
  NG: ['.NYM'],
  RB: ['.NYM'],
  HO: ['.NYM'],
  GC: ['.CMX'],
  SI: ['.CMX'],
  HG: ['.CMX'],
  PL: ['.NYM'],
  PA: ['.NYM'],
  ZC: ['.CBT'],
  ZS: ['.CBT'],
  ZW: ['.CBT'],
  ES: ['.CME'],
  NQ: ['.CME'],
  YM: ['.CME'],
  RTY: ['.CME'],
  '6E': ['.CME'],
  '6J': ['.CME'],
}

/** Generic fallback when a root is unknown: try the common venues. */
const FALLBACK_EXCHANGES = ['.NYM', '.CMX', '.CBT', '.CME', '.NYB'] as const

/**
 * Is this a continuous (spliced) futures symbol?
 * @param symbol - the symbol as the provider reports it.
 * @returns true for the `XXX=F` form.
 */
export function isContinuous(symbol: string): boolean {
  return /^[A-Z0-9]{1,4}=F$/i.test(symbol)
}

/**
 * The root of a continuous symbol.
 * @param symbol - e.g. `CL=F`.
 * @returns `CL`, or null when the symbol is not continuous.
 */
export function continuousRoot(symbol: string): string | null {
  const m = /^([A-Z0-9]{1,4})=F$/i.exec(symbol)
  return m === null ? null : m[1]!.toUpperCase()
}

/**
 * Venues worth trying for one root.
 * @param root - e.g. `CL`.
 * @returns the suffixes to attempt, in order.
 */
export function exchangesFor(root: string): readonly string[] {
  return ROOT_EXCHANGES[root] ?? FALLBACK_EXCHANGES
}

/** One candidate contract month. */
export type CandidateMonth = { monthCode: string; month: number; year: number }

/**
 * The contract months to test against, starting at the given month.
 *
 * Four months is deliberate: a continuous series tracks one of the nearest two, and
 * the extra two exist so a reader can see what comes next — the next roll is a fact
 * worth knowing before it happens, not after.
 * @param now - the reference date; injected so tests are not clock-dependent.
 * @param count - how many months to generate.
 * @returns months in ascending order.
 */
export function candidateMonths(now: Date, count = 4): CandidateMonth[] {
  const out: CandidateMonth[] = []
  let year = now.getUTCFullYear()
  let month = now.getUTCMonth() + 1
  for (let i = 0; i < count; i++) {
    out.push({ monthCode: MONTH_CODES[month - 1]!, month, year })
    month += 1
    if (month > 12) {
      month = 1
      year += 1
    }
  }
  return out
}

/**
 * Build a named contract symbol.
 * @param root - e.g. `CL`.
 * @param candidate - the month.
 * @param exchange - e.g. `.NYM`.
 * @returns e.g. `CLF27.NYM`.
 */
export function contractSymbol(root: string, candidate: CandidateMonth, exchange: string): string {
  return `${root}${candidate.monthCode}${String(candidate.year % 100).padStart(2, '0')}${exchange}`
}

/**
 * Human label for a contract month.
 * @param candidate - the month.
 * @returns e.g. `Jan 2027`.
 */
export function monthLabel(candidate: CandidateMonth): string {
  return `${MONTH_NAMES[candidate.month - 1]} ${candidate.year}`
}

/** A candidate whose price agrees with the continuous series. */
export type ContractMatch = {
  symbol: string
  close: number
  /** Absolute difference from the continuous close, in percent. */
  diffPct: number
}

/**
 * Which named contract is the continuous series currently quoting?
 *
 * The test is a price comparison, not a label lookup: the provider's own name for
 * `CL=F` still said "Dec 26" on the day it was trading January, so trusting the
 * label is exactly the bug this replaces.
 * @param continuousClose - the continuous series' latest close.
 * @param named - each candidate's latest close.
 * @param tolerancePct - maximum allowed difference; two adjacent contract months
 *   differ by around 1%, so anything under a quarter of a percent is the same
 *   instrument rather than a neighbouring month.
 * @returns the closest match inside tolerance, or null when nothing agrees.
 */
export function matchContract(
  continuousClose: number,
  named: readonly { symbol: string; close: number }[],
  tolerancePct = 0.25,
): ContractMatch | null {
  if (!(continuousClose > 0)) return null
  let best: ContractMatch | null = null
  for (const n of named) {
    if (!(n.close > 0)) continue
    const diffPct = Number(((Math.abs(n.close - continuousClose) / continuousClose) * 100).toFixed(3))
    if (diffPct > tolerancePct) continue
    if (best === null || diffPct < best.diffPct) best = { symbol: n.symbol, close: n.close, diffPct }
  }
  return best
}

/**
 * The most recent day the tracked contract changed.
 * @param matches - per day, the matched symbol (null when nothing matched).
 * @param times - the matching bar times, ascending.
 * @returns the switch, or null when the match never changed in the window.
 */
export function lastRoll(
  matches: readonly (string | null)[],
  times: readonly string[],
): { date: string; from: string; to: string } | null {
  for (let i = matches.length - 1; i > 0; i--) {
    const current = matches[i]
    const previous = matches[i - 1]
    // typeof narrows the element type; comparing against null does not survive
    // indexing into a readonly array under noUncheckedIndexedAccess.
    if (typeof current === 'string' && typeof previous === 'string' && current !== previous) {
      return { date: times[i] ? times[i]!.slice(0, 10) : 'unknown', from: previous, to: current }
    }
  }
  return null
}
