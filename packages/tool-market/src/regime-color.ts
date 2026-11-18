/**
 * The four-colour regime classifier.
 *
 * Reconstructed from the author's own published description of his TradingView
 * indicator ("Regime-Filtered Overbought/Oversold V1"): the first layer is a
 * Stochastic used as an EXTREME-STATE ALARM rather than a frequent oscillator
 * signal, and the second layer splits the same reading by trend context —
 *
 *   trend + overbought = red     trend + oversold = green
 *   range + overbought = yellow  range + oversold = blue
 *
 * and, in his words, "the same overbought means a strong continuation in a trend
 * but a mean-reversion opportunity in a range, and the two should not be handled
 * with the same colour or the same expectation."
 *
 * That distinction is the whole point: a bare 'oversold' label is wrong half the
 * time, and this is the smallest honest fix for it. The trend/range split uses
 * ADX — which is what his indicator uses — not the (closed-source) channel.
 *
 * Thresholds are OUR defaults, not his settings: he never published them.
 * @module @dsh-trading/tool-market/regime-color
 */

/** Which side the alarm fired on. */
export type RegimeExtreme = 'overbought' | 'oversold'

/** Which background the alarm fired in. */
export type RegimeBaseline = 'trend' | 'range'

/** The four states, in his naming. */
export type RegimeColor = 'red' | 'green' | 'yellow' | 'blue'

/** Thresholds used to classify a bar. */
export interface RegimeOptions {
  /** ADX at or above this means "trend"; below means "range". */
  adxThreshold: number
  /** Stochastic %K at or above this is overbought. */
  overbought: number
  /** Stochastic %K at or below this is oversold. */
  oversold: number
}

/** Our defaults. Deliberately conventional, and stated as ours rather than his. */
export const REGIME_DEFAULTS: RegimeOptions = { adxThreshold: 20, overbought: 80, oversold: 20 }

/**
 * One classified reading.
 *
 * A type alias, not an interface: the tool layer requires its results to be
 * assignable to `JsonValue`, and interfaces get no implicit index signature.
 */
export type RegimeReading = {
  /** Null when the alarm is not firing — most bars, by design. */
  color: RegimeColor | null
  baseline: RegimeBaseline
  extreme: RegimeExtreme | null
  /** What to do with the reading, in the author's own framing. */
  meaning: string
}

/**
 * Classify one bar of Stochastic and ADX.
 *
 * Returns `color: null` outside the extreme bands: in his design this is an
 * alarm that is usually silent, and silence is information too — it says "this
 * is not the moment", which is an answer.
 * @param stochK - slow stochastic %K at the bar.
 * @param adx - ADX at the bar.
 * @param options - thresholds; defaults are ours.
 * @returns the four-colour reading.
 */
export function regimeReading(
  stochK: number | null,
  adx: number | null,
  options: RegimeOptions = REGIME_DEFAULTS,
): RegimeReading {
  const baseline: RegimeBaseline = adx !== null && adx >= options.adxThreshold ? 'trend' : 'range'
  if (stochK === null) return { color: null, baseline, extreme: null, meaning: 'no reading' }

  const extreme: RegimeExtreme | null =
    stochK >= options.overbought ? 'overbought'
      : stochK <= options.oversold ? 'oversold'
        : null
  if (extreme === null) {
    return { color: null, baseline, extreme, meaning: 'alarm silent — not an extreme' }
  }

  const color: RegimeColor = baseline === 'trend'
    ? (extreme === 'overbought' ? 'red' : 'green')
    : (extreme === 'overbought' ? 'yellow' : 'blue')

  const meaning = baseline === 'trend'
    // A trend does not care that it is stretched: this is continuation, not a turn.
    ? `${extreme} inside a trend — continuation, not a reversal`
    // A range is where the extreme actually means something to fade.
    : `${extreme} inside a range — mean-reversion candidate, not a trend`

  return { color, baseline, extreme, meaning }
}

/**
 * The one-line text a chip or a model sees.
 * @param reading - a classified bar.
 * @returns a short label, e.g. `green (trend · oversold)`.
 */
export function regimeLabel(reading: RegimeReading): string {
  if (reading.color === null) return `silent (${reading.baseline})`
  return `${reading.color} (${reading.baseline} · ${reading.extreme})`
}
