/**
 * The judgment layer: adjudicate a proposed setup against the framework's gates.
 *
 * This module does NOT invent a setup, and deliberately does not compute targets.
 * His T1/T2/T3 method is closed-source ("全部只有結果描述" — docs/06 §12), and the
 * corpus's own reconstruction doc lists "用 ATR 推導 T1/T2" as a HIGH-severity
 * error (docs/06 §11). So the contract is inverted: the caller proposes
 * entry / stop / targets, and this module **adjudicates** — the same posture as
 * audit_backtest, which likewise refuses to certify what it cannot verify.
 *
 * Three of his rules are encoded directly:
 *
 *  1. **Entry, Stop and Target must arrive together.** "缺少任何一個都絕不能下手"
 *     — a missing leg is a veto, not a soft score.
 *  2. **Timeframe alignment has veto power only.** A weekly/daily disagreement can
 *     forbid a trade; it can never select a direction.
 *  3. **Cross-asset may only veto.** It cannot start a setup, and a stretched ratio
 *     may stay stretched, so no threshold is assumed: without one from the caller
 *     the gate reports `unknown` rather than inventing a rule.
 *
 * What the framework has and we do not — 打點, 選美, Ariston Channel, the 主力 flow
 * data — is reported as `unknown` and never silently treated as passed. That is
 * the honest version of "六個系統的與閘": a gate nobody can evaluate does not open.
 * @module @dsh-trading/tool-market/setup
 */

import type { Candle } from '@dsh-trading/market-data'
import { regimeReading } from './regime-color.js'
import { nearestLevels, findSwings, windowOf } from './structure.js'
import { adx, atr, stochastic } from './candle-indicators.js'

/** One gate's outcome. */
export type GateStatus = 'pass' | 'veto' | 'unknown'

/** A gate, with the evidence behind its status. */
export type Gate = {
  id: 'data' | 'alignment' | 'three-piece' | 'direction' | 'structure' | 'risk-reward' | 'cross-asset' | 'unavailable'
  status: GateStatus
  /** One line a reader can check. */
  detail: string
}

/** The verdict. `stand aside` is a first-class answer, not a failure. */
export type SetupVerdict = 'act' | 'stand aside' | 'unknown'

/** A trade the reader proposes, to be adjudicated. */
export type Proposal = {
  direction: 'long' | 'short'
  entry: number
  /** The price that admits the read was wrong. */
  invalidation: number
  /** T1 first; T2/T3 optional. At least one required. */
  targets: number[]
}

/** Optional cross-asset leg the caller wants considered. */
export type CrossAssetVeto = {
  /** e.g. 'HG=F/GC=F'. */
  pair: string
  /** Where the ratio sits in its own window, 0..100. */
  percentile: number
  /** Optional caller-defined veto rule; without it the gate cannot judge. */
  vetoAbove?: number
  vetoBelow?: number
}

/** Everything the adjudication returns. */
export type SetupReview = {
  symbol: string
  timeframe: string
  close: number
  verdict: SetupVerdict
  /** Rule that decided it, in one sentence. */
  reason: string
  gates: Gate[]
  /** Risk/reward for each supplied target, in order. */
  riskReward: number[]
  /** ATR at the bar, for sizing the stop's width honestly. */
  atr: number | null
}

/** ATR multiple inside which an entry counts as "at structure" rather than adrift. */
export const ENTRY_NEAR_LEVEL_ATR = 1
/** Minimum reward:risk for the first target. */
export const MIN_RR = 1

/**
 * Did weekly/daily-style alignment pass?
 *
 * Both timeframes must agree on trend direction, and his rule is that this gate
 * can only FORBID: `pass` here means "no objection raised", never "go long".
 * @param fast - the lower timeframe's candles.
 * @param slow - the higher timeframe's candles.
 * @returns the gate, with each leg's ADX and DI named in the detail.
 */
export function alignmentGate(fast: readonly Candle[], slow: readonly Candle[]): Gate {
  const read = (candles: readonly Candle[]): { adx: number | null; up: boolean | null } => {
    if (candles.length < 20) return { adx: null, up: null }
    const r = adx(candles)
    const value = r.adx[r.adx.length - 1]
    const plus = r.plusDi[r.plusDi.length - 1]
    const minus = r.minusDi[r.minusDi.length - 1]
    if (value === undefined || value === null) return { adx: null, up: null }
    if (plus === undefined || plus === null || minus === undefined || minus === null) return { adx: null, up: null }
    return { adx: value, up: plus >= minus }
  }
  const f = read(fast)
  const s = read(slow)
  if (f.adx === null || s.adx === null) {
    return { id: 'alignment', status: 'unknown', detail: 'not enough bars to read ADX on both timeframes' }
  }
  const trending = f.adx >= 20 && s.adx >= 20
  if (!trending) {
    // His step 1 is explicit: weekly < 20 with daily >= 20 means short-term only,
    // do not hold; both < 20 means do not trade. Which one applies depends on the
    // holding period the caller intends, and the tool cannot know that — so it
    // reports the rule rather than picking a verdict on the caller's behalf.
    const both = f.adx < 20 && s.adx < 20
    return {
      id: 'alignment',
      status: 'unknown',
      detail: both
        ? `neither timeframe trends (fast ${f.adx.toFixed(1)}, slow ${s.adx.toFixed(1)}, need both >= 20) — his step 1: do not trade`
        : `higher timeframe is not trending (slow ${s.adx.toFixed(1)} < 20, fast ${f.adx.toFixed(1)}) — his step 1 permits short-term only, no held trend position; the tool cannot know your intended horizon`,
    }
  }
  if (f.up !== s.up) {
    return {
      id: 'alignment',
      status: 'veto',
      detail: `timeframes disagree on direction (fast ${f.up ? '+DI' : '-DI'}, slow ${s.up ? '+DI' : '-DI'} dominant) — his rule forbids a trend entry`,
    }
  }
  return {
    id: 'alignment',
    status: 'pass',
    detail: `both timeframes trending ${f.up ? 'up' : 'down'} (ADX ${f.adx.toFixed(1)} / ${s.adx.toFixed(1)}); this gate only withholds objection, it never picks a side`,
  }
}

/**
 * Adjudicate a proposal.
 * @param input - symbol, timeframe, candles for each timeframe, the proposal, and
 *   optional cross-asset veto data.
 * @returns the review: gates, risk/reward per target, and a verdict.
 */
export function reviewSetup(input: {
  symbol: string
  timeframe: string
  candles: readonly Candle[]
  higherTimeframe?: readonly Candle[] | undefined
  proposal: Proposal
  crossAsset?: CrossAssetVeto | undefined
}): SetupReview {
  const { candles, proposal } = input
  if (candles.length < 20) throw new Error('setup review needs at least 20 bars')
  const close = candles[candles.length - 1]!.close
  const atrValues = atr(candles)
  const atrV = atrValues[atrValues.length - 1] ?? null
  const gates: Gate[] = []

  // 1. Data: say what was read, and flag a continuous contract for what it is.
  gates.push({
    id: 'data',
    status: 'pass',
    detail: `${candles.length} bars, last ${candles[candles.length - 1]!.time}, close ${close}${input.symbol.includes('=F') ? ' — continuous front-month: history is stitched across rolls, so cross-month price comparisons are not returns' : ''}`,
  })

  // 2. The three-piece rule: a missing leg is a veto, never a soft score.
  const targets = proposal.targets.filter(t => Number.isFinite(t) && t > 0)
  const missing = [
    proposal.entry > 0 ? null : 'entry',
    proposal.invalidation > 0 ? null : 'stop',
    targets.length > 0 ? null : 'target',
  ].filter((x): x is string => x !== null)
  gates.push(missing.length === 0
    ? { id: 'three-piece', status: 'pass', detail: `entry ${proposal.entry}, stop ${proposal.invalidation}, ${targets.length} target(s)` }
    : { id: 'three-piece', status: 'veto', detail: `missing ${missing.join(' / ')} — his rule: Entry, Stop and Target must appear together, or nothing is done` })

  // 3. Direction against the regime reading (trend + oversold = continuation, not a reversal).
  const k = stochastic(candles).k
  const adxValues = adx(candles)
  const adxV = adxValues.adx[adxValues.adx.length - 1] ?? null
  const reading = regimeReading(k[k.length - 1] ?? null, adxV)
  const stretch = reading.extreme !== null
  const wantsReversion = proposal.direction === 'long' ? reading.extreme === 'oversold' : reading.extreme === 'overbought'
  if (reading.color === null) {
    gates.push({ id: 'direction', status: 'pass', detail: `alarm silent (${reading.baseline}) — no extreme to argue with the proposal` })
  } else if (reading.baseline === 'trend' && wantsReversion) {
    gates.push({
      id: 'direction',
      status: 'veto',
      detail: `proposal is a ${reading.extreme} fade while the regime says ${reading.color} (trend continuation) — the same reading means the opposite in a trend`,
    })
  } else {
    gates.push({ id: 'direction', status: 'pass', detail: `regime ${reading.color} (${reading.baseline} · ${reading.extreme}): ${reading.meaning}` })
  }

  // 4. Alignment, when a second timeframe was supplied.
  if (input.higherTimeframe !== undefined) gates.push(alignmentGate(candles, input.higherTimeframe))

  // 5. Structure: is the entry at a level, or in the middle of nowhere?
  const swings = findSwings(candles)
  const { resistance, support } = nearestLevels(swings, proposal.entry)
  const nearest = proposal.direction === 'long' ? support : resistance
  if (atrV === null) {
    gates.push({ id: 'structure', status: 'unknown', detail: 'ATR unavailable, cannot judge how far the entry sits from structure' })
  } else if (nearest === null) {
    gates.push({
      id: 'structure',
      status: 'unknown',
      detail: `no confirmed ${proposal.direction === 'long' ? 'support' : 'resistance'} on that side — a fresh extreme has none by construction (a fractal needs 3 bars after it)`,
    })
  } else {
    const gap = Math.abs(proposal.entry - nearest.price) / atrV
    gates.push(gap <= ENTRY_NEAR_LEVEL_ATR
      ? { id: 'structure', status: 'pass', detail: `entry is ${gap.toFixed(2)} ATR from ${nearest.price} (${nearest.source})` }
      : { id: 'structure', status: 'veto', detail: `entry is ${gap.toFixed(2)} ATR from the nearest confirmed level (${nearest.price}, ${nearest.source}) — adrift, not at structure` })
  }

  // 6. Risk/reward per target, first one binding.
  const risk = Math.abs(proposal.entry - proposal.invalidation)
  const wrongSide = proposal.direction === 'long'
    ? proposal.invalidation >= proposal.entry
    : proposal.invalidation <= proposal.entry
  if (risk === 0) {
    gates.push({ id: 'risk-reward', status: 'veto', detail: 'stop equals entry: no risk defined' })
  } else if (wrongSide) {
    gates.push({ id: 'risk-reward', status: 'veto', detail: `stop ${proposal.invalidation} is on the wrong side of entry ${proposal.entry} for a ${proposal.direction}` })
  }
  const riskReward = targets.map(t => {
    const reward = proposal.direction === 'long' ? t - proposal.entry : proposal.entry - t
    return risk === 0 ? 0 : Number((reward / risk).toFixed(2))
  })
  if (risk > 0 && !wrongSide && riskReward.length > 0) {
    const first = riskReward[0]!
    gates.push(first >= MIN_RR
      ? { id: 'risk-reward', status: 'pass', detail: `T1 at ${targets[0]} gives ${first}:1 (risk ${risk.toFixed(4)})` }
      : { id: 'risk-reward', status: 'veto', detail: `T1 at ${targets[0]} gives only ${first}:1 — under the ${MIN_RR}:1 floor` })
  }

  // 7. Cross-asset may only veto, and only under a caller-supplied rule.
  if (input.crossAsset !== undefined) {
    const { pair, percentile, vetoAbove, vetoBelow } = input.crossAsset
    if (vetoAbove === undefined && vetoBelow === undefined) {
      gates.push({ id: 'cross-asset', status: 'unknown', detail: `${pair} at percentile ${percentile}, but no veto threshold was supplied — a stretched ratio can stay stretched, so this module will not assume one` })
    } else if (vetoAbove !== undefined && percentile >= vetoAbove) {
      gates.push({ id: 'cross-asset', status: 'veto', detail: `${pair} at percentile ${percentile} is at or above the caller's veto line ${vetoAbove}` })
    } else if (vetoBelow !== undefined && percentile <= vetoBelow) {
      gates.push({ id: 'cross-asset', status: 'veto', detail: `${pair} at percentile ${percentile} is at or below the caller's veto line ${vetoBelow}` })
    } else {
      gates.push({ id: 'cross-asset', status: 'pass', detail: `${pair} at percentile ${percentile} — inside the caller's bounds` })
    }
  }

  // 8. What the framework has and we cannot evaluate: named, never silently passed.
  gates.push({
    id: 'unavailable',
    status: 'unknown',
    detail: 'not implemented and not guessable: 打點 (momentum countdown), 選美 (cross-instrument ranking), Ariston Channel, 主力 fund flow — all closed-source in the corpus',
  })

  // Verdict: a veto is fatal, a substantive unknown is a veto too, silence is not consent.
  const veto = gates.find(g => g.status === 'veto')
  const substantiveUnknown = gates.find(g => g.status === 'unknown' && g.id !== 'unavailable' && g.id !== 'cross-asset')
  const verdict: SetupVerdict = veto !== undefined
    ? 'stand aside'
    : substantiveUnknown !== undefined
      ? 'stand aside'
      : 'act'
  const reason = veto !== undefined
    ? `${veto.id}: ${veto.detail}`
    : substantiveUnknown !== undefined
      ? `${substantiveUnknown.id}: ${substantiveUnknown.detail}`
      : 'entry, stop and target are complete, at structure, and no gate objects'

  return { symbol: input.symbol, timeframe: input.timeframe, close, verdict, reason, gates, riskReward, atr: atrV === null ? null : Number(atrV.toFixed(4)) }
}

/**
 * Render the review as the block a reader sees.
 * @param r - a completed review.
 * @returns multi-line text, verdict first, then every gate with its status.
 */
export function renderSetup(r: SetupReview): string {
  const icon = (s: GateStatus): string => s === 'pass' ? 'PASS' : s === 'veto' ? 'VETO' : 'UNKNOWN'
  return [
    `${r.symbol} @ ${r.timeframe} · close ${r.close} · ATR ${r.atr ?? '–'}`,
    `VERDICT: ${r.verdict.toUpperCase()} — ${r.reason}`,
    ...r.gates.map(g => `  [${icon(g.status)}] ${g.id}: ${g.detail}`),
    r.riskReward.length > 0 ? `  reward:risk ${r.riskReward.map((v, i) => `T${i + 1} ${v}:1`).join(', ')}` : '  reward:risk: no targets supplied',
    '  targets are yours, not this tool\'s: his T1/T2/T3 derivation is unpublished, and this module refuses to invent one.',
  ].join('\n')
}
