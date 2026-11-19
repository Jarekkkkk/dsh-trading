/**
 * Model-facing market tools. Read-only by contract: this package (and the
 * dsh-trading project) exposes RESEARCH capabilities — nothing here places,
 * routes, or simulates-then-forwards orders, and no order-execution seam
 * exists for a plugin to reach. Analysis stops at the screen.
 * @module @dsh-trading/tool-market
 */

import { mkdir, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { Candle, Timeframe } from '@dsh-trading/market-data'
import { ema, macd } from './candle-indicators.js'
import { rsi, sma } from './indicators.js'
import { regimeSnapshot, renderSnapshot } from './regime.js'
import { describeCrossAsset, joinLegs, renderCrossAsset } from './cross-asset.js'
import { renderStructure, structureReport } from './structure.js'
import { renderSetup, reviewSetup } from './setup.js'
import { DEFAULT_CHANNEL_BARS, channelOf, renderChannel } from './channel.js'
import { DEFAULT_HORIZON, energyDecay, renderEnergyDecay } from './energy-decay.js'
import { candidateMonths, continuousRoot, contractSymbol, exchangesFor, isContinuous, matchContract, monthLabel, lastRoll } from './contract.js'
import { chartHtml, renderChartSvg } from './chart.js'
import type { ChartLevel, ChartOverlay } from './chart.js'
import { chartCandles, chartSeries, regimeSeries, roundSeries } from './chart-payload.js'
import type { AnnotationRole, ChartAnnotation, ChartPayload, ChartScenario, ChartTimeframeData } from './chart-payload.js'
import { resolveWalkthrough, WALK_FIELDS, WALK_MARK_TYPES, WALK_PANES } from './walkthrough.js'
import type { WalkthroughArgs, WalkthroughPayload } from './walkthrough.js'

export { rsi, sma } from './indicators.js'
export { adx, atr, bollinger, ema, macd, mfi, stochastic } from './candle-indicators.js'
export { regimeSnapshot, renderSnapshot } from './regime.js'
export { regimeLabel, regimeReading, REGIME_DEFAULTS } from './regime-color.js'
export { describeCrossAsset, joinLegs, renderCrossAsset, MIN_BARS_FOR_PERCENTILE } from './cross-asset.js'
export { findFailedBreak, findSwings, nearestLevels, renderStructure, structureReport, windowOf, DEFAULT_WINDOWS } from './structure.js'
export { alignmentGate, renderSetup, reviewSetup, ENTRY_NEAR_LEVEL_ATR, MIN_RR } from './setup.js'
export { channelOf, renderChannel, DEFAULT_CHANNEL_BARS, MIN_R2, RAIL_SIGMA } from './channel.js'
export type { Channel, ChannelBreak } from './channel.js'
export { energyDecay, renderEnergyDecay, DEFAULT_HORIZON, MIN_EVENTS } from './energy-decay.js'
export { candidateMonths, continuousRoot, contractSymbol, exchangesFor, isContinuous, lastRoll, matchContract, monthLabel, MONTH_CODES } from './contract.js'
export type { CandidateMonth, ContractMatch } from './contract.js'
export type { DecayEvent, DecayVerdict, EnergyDecayResult } from './energy-decay.js'
export type { CrossAssetVeto, Gate, GateStatus, Proposal, SetupReview, SetupVerdict } from './setup.js'
export type { FailedBreak, StructureLevel, StructureReport, Swing, Window } from './structure.js'
export type { CrossAssetResult, Leg, RatioPoint } from './cross-asset.js'
export type { RegimeBaseline, RegimeColor, RegimeExtreme, RegimeOptions, RegimeReading } from './regime-color.js'
export type { RegimeSnapshot } from './regime.js'
export { chartHtml, renderChartSvg } from './chart.js'
export type { ChartLevel, ChartOptions, ChartOverlay } from './chart.js'
export { chartCandles, chartSeries, regimeSeries, roundSeries, CHART_META_BARS } from './chart-payload.js'
export type {
  AnnotationRole, ChartAnnotation, ChartCandle, ChartLevelAnnotation, ChartPayload,
  ChartScenario, ChartSeries, ChartTimeframeData, ChartZoneAnnotation,
} from './chart-payload.js'
export { resolveWalkthrough, PANE_COLUMNS, WALK_FIELDS, WALK_MARK_TYPES, WALK_PANES } from './walkthrough.js'
export type {
  WalkField, WalkLine, WalkMark, WalkPane, WalkPoint, WalkSurface, WalkthroughArgs, WalkthroughPayload,
} from './walkthrough.js'

export const name = 'tool-market'
export const inject = ['tools', 'marketData']

export interface Config {
  /** Directory charts are written to, relative to the process working directory. */
  chartDir: string
}

/**
 * Asserted rather than inferred: schemastery 3.19 splits a schema's input type from its
 * output type, so an unannotated `.default()` field reads as `T | Volatile<T>` and the
 * inferred schema type cannot be named in a emitted `.d.ts` under pnpm's layout. Nothing
 * here opts into `.volatile()`, and dsh resolves defaults before `apply`.
 */
export const Config = z.object({
  chartDir: z.string().default('./charts'),
}) as z<Config>

const TIMEFRAMES = ['1m', '5m', '15m', '30m', '1h', '4h', '1d', '1w'] as const

/**
 * Hard cap on bars served by one get_ohlcv call. The CSV block is rendered
 * into model context; an uncapped limit lets a single call crowd out the
 * analysis it was fetched for.
 */
const MAX_OHLCV_BARS = 2000

/** Render candles (+ indicator columns) as the CSV block the model reads. */
function renderCsv(candles: Candle[], indicators: Record<string, (number | null)[]>): string {
  const extraNames = Object.keys(indicators)
  const header = ['time,open,high,low,close,volume', ...extraNames].join(',')
  const rows = candles.map((c, i) => [
    `${c.time},${c.open},${c.high},${c.low},${c.close},${c.volume}`,
    ...extraNames.map(name => indicators[name]![i]?.toFixed(4) ?? ''),
  ].join(','))
  return [header, ...rows].join('\n')
}

export function apply(ctx: Context, config: Config): void {
  ctx.tools.register(defineTool({
    name: 'list_symbols',
    description: 'List the instruments available from the mounted market-data providers, with the timeframes each one can serve. Call this before get_ohlcv when unsure which symbols exist.',
    parameters: {
      provider: { type: 'string', description: 'Provider id to enumerate. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          symbols: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                symbol: { type: 'string', required: true },
                timeframes: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.symbols.length === 0
          ? `Provider '${value.provider}' has no instruments.`
          : value.symbols.map(s => `${s.symbol}${s.timeframes ? ` (${s.timeframes.join(', ')})` : ''}`).join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const symbols = await provider.listSymbols()
      return {
        provider: provider.id,
        symbols: symbols.map(s => ({
          symbol: s.symbol,
          ...s.timeframes ? { timeframes: [...s.timeframes] } : {},
        })),
      }
    },
    presentCall: args => ({ card: 'generic', title: 'List symbols', kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_symbol',
    description: 'Resolve an instrument name, a Chinese company name or a broker-style code (US.MU, HK.00700) to the exact symbol this market feed can chart. Call this when the reader names an instrument in words instead of the provider symbol — never guess a ticker and then report data for the wrong company.',
    parameters: {
      query: { type: 'string', required: true, description: 'What the reader called it: "腾讯", "台积电", "tesla", "US.MU", "700 HK".' },
      provider: { type: 'string', description: 'Provider id to search. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          query: { type: 'string', required: true },
          matches: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                symbol: { type: 'string', required: true },
                name: { type: 'string' },
                assetClass: { type: 'string' },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: value.matches.length === 0
          ? `No instrument matched '${value.query}'. Ask the reader for the exact ticker, or list_symbols for the catalogue.`
          : value.matches
            .map(m => `${m.symbol}${m.name !== undefined ? ` — ${m.name}` : ''}${m.assetClass !== undefined ? ` (${m.assetClass})` : ''}`)
            .join('\n'),
      }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const matches = provider.search === undefined ? [] : await provider.search(args.query)
      return {
        provider: provider.id,
        query: args.query,
        matches: matches.slice(0, 8).map(m => ({
          symbol: m.symbol,
          ...m.name !== undefined ? { name: m.name } : {},
          ...m.assetClass !== undefined ? { assetClass: m.assetClass } : {},
        })),
      }
    },
    presentCall: args => ({ card: 'generic', title: `Resolve ${args.query}`, kind: 'read', rawInput: args }),
  }))

  ctx.tools.register(defineTool({
    name: 'get_ohlcv',
    description: 'Fetch OHLCV candles for one symbol and timeframe as CSV, optionally with SMA/RSI indicator columns. Times are ISO-8601 UTC bar-open times, ascending. Use list_symbols first if the symbol universe is unknown.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframe: { type: 'string', required: true, enum: [...TIMEFRAMES], description: 'Bar interval.' },
      start: { type: 'string', description: 'Inclusive ISO-8601 range start (bar open time).' },
      end: { type: 'string', description: 'Inclusive ISO-8601 range end.' },
      limit: { type: 'integer', description: `Max bars, counted from the end of the range. Default 200, maximum ${MAX_OHLCV_BARS}.` },
      sma: { type: 'array', items: { type: 'integer' }, description: 'SMA windows to append as columns, e.g. [20, 50].' },
      rsi: { type: 'integer', description: 'RSI period to append as a column, e.g. 14.' },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          symbol: { type: 'string', required: true },
          timeframe: { type: 'string', required: true },
          count: { type: 'integer', required: true },
          csv: { type: 'string', required: true },
          // Chart tail for the web card (@dsh-trading/client-chart), or null.
          // A json node compiles to an annotation-only schema, so this is not
          // a wire break; render() below never mentions it, so the model's
          // context does not grow by a byte.
          chart: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.symbol} @ ${value.timeframe} from '${value.provider}' — ${value.count} bars\n${value.csv}`,
      }],
      // Persisted on the durable tool/result event's `meta`: the card reads it
      // live and on session replay; the model never sees it.
      presentationMeta: (_args, value) => {
        const chart = value.chart as ChartTimeframeData | null
        if (chart === null) return null
        const payload: ChartPayload = {
          kind: 'chart',
          version: 1,
          provider: value.provider,
          symbol: value.symbol,
          timeframes: [chart],
        }
        return payload
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      if (args.limit !== undefined && args.limit > MAX_OHLCV_BARS) {
        throw new Error(`limit ${args.limit} exceeds the maximum ${MAX_OHLCV_BARS} bars per call — page through history with start/end ranges instead`)
      }
      const timeframe = args.timeframe as (typeof TIMEFRAMES)[number]
      const candles = await provider.getOhlcv({
        symbol: args.symbol,
        timeframe,
        ...args.start !== undefined ? { start: args.start } : {},
        ...args.end !== undefined ? { end: args.end } : {},
        limit: args.limit ?? 200,
      })
      const closes = candles.map(c => c.close)
      const indicators: Record<string, (number | null)[]> = {}
      for (const window of args.sma ?? []) indicators[`sma${window}`] = sma(closes, window)
      if (args.rsi !== undefined) indicators[`rsi${args.rsi}`] = rsi(closes, args.rsi)
      // Requested columns enter the payload at the same reporting precision
      // regimeSeries uses (CONTRACTS §2.1: rounded once, producer-side) — a
      // requested rsi14 must be byte-identical to the regime's rsi14, not a
      // full-precision shadow of it.
      const roundedIndicators = Object.fromEntries(Object.entries(indicators)
        .map(([name, values]) => [name, roundSeries(values, name.startsWith('rsi') ? 2 : 4)]))
      const tail = chartCandles(candles)
      const chart: ChartTimeframeData | null = tail === null || tail.length === 0 ? null : {
        timeframe,
        candles: tail,
        indicators: regimeSnapshot(candles),
        // Regime set first; requested columns win a name clash (identical after rounding).
        series: chartSeries({ ...regimeSeries(candles), ...roundedIndicators }),
      }
      return {
        provider: provider.id,
        symbol: args.symbol,
        timeframe: args.timeframe,
        count: candles.length,
        csv: renderCsv(candles, indicators),
        chart,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Candles: ${args.symbol} @ ${args.timeframe}`,
      kind: 'read',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'market_snapshot',
    description: 'Multi-timeframe indicator dashboard for one symbol: latest close, RSI14, slow stochastic, ADX/DI, MACD(12,26,9), MFI14, ATR14, SMA20/50/200 + EMA20 posture, Bollinger(20,2) — each with a coarse state label. Call this FIRST when asked to analyse an instrument; fetch raw candles with get_ohlcv only when you need bar-level structure.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframes: {
        type: 'array',
        items: { type: 'string', enum: [...TIMEFRAMES] },
        description: 'Timeframes to compute, e.g. ["1d", "4h"]. Default ["1d"].',
      },
      bars: { type: 'integer', description: 'Bars fetched per timeframe (more = better-seeded slow indicators). Default 300.' },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          symbol: { type: 'string', required: true },
          timeframes: {
            type: 'array',
            required: true,
            items: {
              type: 'object',
              additionalProperties: false,
              properties: {
                timeframe: { type: 'string', required: true },
                rendered: { type: 'string', required: true },
                // The full RegimeSnapshot, as an unconstrained JSON node: UI
                // cards will read it, and adding an indicator must not be a
                // wire-schema break.
                indicators: { type: 'json', required: true },
                // Chart tail + per-bar indicator series for the web card, or
                // null. Never rendered to the model; the durable copies travel
                // via presentationMeta below.
                candles: { type: 'json', required: true },
                series: { type: 'json', required: true },
              },
            },
          },
        },
      },
      render: (_args, value) => [{
        type: 'text',
        text: `${value.symbol} indicator regime from '${value.provider}':\n${value.timeframes.map(t => t.rendered).join('\n')}`,
      }],
      presentationMeta: (_args, value) => {
        const payload: ChartPayload = {
          kind: 'chart',
          version: 1,
          provider: value.provider,
          symbol: value.symbol,
          timeframes: value.timeframes
            .filter(t => t.candles !== null)
            .map(t => ({
              timeframe: t.timeframe,
              candles: t.candles,
              indicators: t.indicators,
              series: t.series,
            }) as ChartTimeframeData),
        }
        return payload
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const timeframes = (args.timeframes ?? ['1d']) as Timeframe[]
      const results = await Promise.all(timeframes.map(async (timeframe) => {
        const candles = await provider.getOhlcv({ symbol: args.symbol, timeframe, limit: args.bars ?? 300 })
        if (candles.length === 0) throw new Error(`no candles for ${args.symbol} @ ${timeframe}`)
        const snapshot = regimeSnapshot(candles)
        return {
          timeframe,
          rendered: renderSnapshot(timeframe, snapshot),
          indicators: snapshot,
          candles: chartCandles(candles),
          series: chartSeries(regimeSeries(candles)),
        }
      }))
      return { provider: provider.id, symbol: args.symbol, timeframes: results }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Indicator regime: ${args.symbol}`,
      kind: 'read',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'render_chart',
    description: 'Draw a candlestick chart to a self-contained HTML file and return its path: candles with volume, optional SMA/EMA overlays, and dashed horizontal lines for the levels you name. Use it to show the structure an analysis argues for — call it AFTER market_snapshot so the levels you mark are ones you actually read.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframe: { type: 'string', required: true, enum: [...TIMEFRAMES], description: 'Bar interval to draw.' },
      bars: { type: 'integer', description: 'How many recent bars to draw. Default 120; more than ~400 renders too densely to read.' },
      sma: { type: 'array', items: { type: 'integer' }, description: 'SMA windows to overlay, e.g. [20, 50].' },
      ema: { type: 'array', items: { type: 'integer' }, description: 'EMA windows to overlay, e.g. [20].' },
      macd: { type: 'boolean', description: 'Overlay the MACD line instead of leaving the pane to price alone. Rarely useful on a price axis; default false.' },
      levels: {
        type: 'array',
        description: 'Horizontal lines to mark, e.g. support, resistance, band edges.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            price: { type: 'number', required: true },
            label: { type: 'string', required: true, description: 'Short caption drawn above the line.' },
          },
        },
      },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          path: { type: 'string', required: true },
          symbol: { type: 'string', required: true },
          timeframe: { type: 'string', required: true },
          bars: { type: 'integer', required: true },
          firstTime: { type: 'string', required: true },
          lastTime: { type: 'string', required: true },
        },
      },
      // The SVG itself never reaches the model: it is tens of kilobytes of path
      // data that would crowd out the analysis it exists to illustrate.
      render: (_args, value) => [{
        type: 'text',
        text: `Chart written to ${value.path} — ${value.symbol} @ ${value.timeframe}, ${value.bars} bars (${value.firstTime} … ${value.lastTime}). Open it in a browser to view.`,
      }],
    },
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const candles = await provider.getOhlcv({
        symbol: args.symbol,
        timeframe: args.timeframe as Timeframe,
        limit: args.bars ?? 120,
      })
      if (candles.length === 0) throw new Error(`no candles for ${args.symbol} @ ${args.timeframe}`)
      const closes = candles.map(c => c.close)
      const overlays: ChartOverlay[] = [
        ...(args.sma ?? []).map(w => ({ name: `SMA${w}`, values: sma(closes, w) })),
        ...(args.ema ?? []).map(w => ({ name: `EMA${w}`, values: ema(closes, w) })),
        ...args.macd === true ? [{ name: 'MACD', values: macd(closes).macd }] : [],
      ]
      const levels: ChartLevel[] = (args.levels ?? []).map(l => ({ price: l.price, label: l.label }))
      const title = `${args.symbol} · ${args.timeframe} · ${candles.length} bars`
      const svg = renderChartSvg({ title, candles, overlays, levels })

      // Names are per symbol+timeframe, not per call: a re-drawn chart should
      // replace the one it supersedes rather than litter the directory.
      const dir = isAbsolute(config.chartDir) ? config.chartDir : resolve(process.cwd(), config.chartDir)
      const path = join(dir, `${args.symbol.replace(/[^\w.-]/g, '_')}-${args.timeframe}.html`)
      await mkdir(dirname(path), { recursive: true })
      await writeFile(path, chartHtml(title, svg))
      return {
        path,
        symbol: args.symbol,
        timeframe: args.timeframe,
        bars: candles.length,
        firstTime: candles[0]!.time,
        lastTime: candles[candles.length - 1]!.time,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Chart: ${args.symbol} @ ${args.timeframe}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  const ANNOTATION_ROLES = ['support', 'resistance', 'neckline', 'target', 'invalidation', 'other'] as const

  // Structural caps: a card is a readable analysis surface, not a dump.
  const MAX_ANNOTATIONS = 24
  const MAX_SCENARIOS = 6
  const MAX_SOURCES = 6
  const MAX_PATH_POINTS = 12

  /** Strip control characters and cap length: model-authored text lands in a
   * durable log and is rendered by arbitrary ecosystem renderers. */
  const clean = (s: string, cap: number): string =>
    s.replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, cap)

  ctx.tools.register(defineTool({
    name: 'annotate_chart',
    description: 'Draw your analysis onto the interactive chart card: horizontal levels and zones, time-anchored paths (necklines, measured moves, pattern legs) — each with MANDATORY provenance sources — plus optional bull/bear scenarios with a trigger and an invalidation. Every price is hard-validated against the real candle window (\u00b130% of its low..high; roles target/invalidation get a wider \u00d70.5..\u00d72 band), so call market_snapshot or get_ohlcv FIRST and anchor on prices you actually read. Scenarios are research hypotheses labelled base/alternative \u2014 never trade recommendations, never numeric probabilities.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframe: { type: 'string', required: true, enum: [...TIMEFRAMES], description: 'Timeframe the analysis was read on; prices are validated against THIS window.' },
      bars: { type: 'integer', description: 'Window drawn and validated against. Default 200.' },
      levels: {
        type: 'array',
        description: 'Horizontal price levels. Each must cite the evidence it rests on.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            price: { type: 'number', required: true },
            label: { type: 'string', required: true, description: 'Short caption, e.g. "double-bottom neckline".' },
            role: { type: 'string', enum: [...ANNOTATION_ROLES], description: 'Default "other".' },
            sources: { type: 'array', required: true, items: { type: 'string' }, description: 'Provenance, e.g. ["Fibonacci 0.618", "prior swing low"]. At least one.' },
            confidence: { type: 'number', description: '0..1. Omit rather than invent.' },
          },
        },
      },
      zones: {
        type: 'array',
        description: 'Horizontal price bands (supply/demand, confluence areas).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            low: { type: 'number', required: true },
            high: { type: 'number', required: true },
            label: { type: 'string', required: true },
            role: { type: 'string', enum: [...ANNOTATION_ROLES] },
            sources: { type: 'array', required: true, items: { type: 'string' } },
            confidence: { type: 'number' },
          },
        },
      },
      paths: {
        type: 'array',
        description: 'Time-anchored point sequences: pattern necklines, ABCD legs, measured moves. Times must be bar-open times inside the drawn window (small forward projection allowed).',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            points: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  time: { type: 'string', required: true, description: 'ISO-8601 UTC bar-open time.' },
                  price: { type: 'number', required: true },
                },
              },
            },
            label: { type: 'string', required: true },
            role: { type: 'string', enum: [...ANNOTATION_ROLES] },
            sources: { type: 'array', required: true, items: { type: 'string' } },
          },
        },
      },
      scenarios: {
        type: 'array',
        description: 'Conditional research scenarios: thesis + what confirms it + what kills it. stance labels the primary reading; it is not a probability.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            direction: { type: 'string', required: true, enum: ['bull', 'bear'] },
            stance: { type: 'string', required: true, enum: ['base', 'alternative'] },
            thesis: { type: 'string', required: true },
            trigger: { type: 'string', required: true, description: 'Observable that confirms the scenario.' },
            invalidation: { type: 'string', required: true, description: 'Observable that kills it.' },
            triggerPrice: { type: 'number', description: 'Optional price the trigger crosses; range-gated.' },
            invalidationPrice: { type: 'number', description: 'Optional price the invalidation crosses; range-gated.' },
          },
        },
      },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          provider: { type: 'string', required: true },
          symbol: { type: 'string', required: true },
          timeframe: { type: 'string', required: true },
          summary: { type: 'string', required: true },
          chart: { type: 'json', required: true },
          scenarios: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
      presentationMeta: (_args, value) => {
        const chart = value.chart as ChartTimeframeData
        const scenarios = value.scenarios as ChartScenario[]
        const payload: ChartPayload = {
          kind: 'chart',
          version: 1,
          provider: value.provider,
          symbol: value.symbol,
          timeframes: [chart],
          ...scenarios.length > 0 ? { scenarios } : {},
        }
        return payload
      },
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const timeframe = args.timeframe as Timeframe
      const candles = await provider.getOhlcv({ symbol: args.symbol, timeframe, limit: args.bars ?? 200 })
      if (candles.length === 0) throw new Error(`no candles for ${args.symbol} @ ${timeframe}`)
      const lo = Math.min(...candles.map(c => c.low))
      const hi = Math.max(...candles.map(c => c.high))
      const lastClose = candles[candles.length - 1]!.close
      const firstMs = Date.parse(candles[0]!.time)
      const lastMs = Date.parse(candles[candles.length - 1]!.time)
      const forwardMs = Math.max(0, (lastMs - firstMs) * 0.1)
      const range = `actual ${timeframe} window is low ${lo} \u2026 high ${hi} over the last ${candles.length} bars`
      const checkPrice = (price: number, what: string, role: AnnotationRole): void => {
        // Projection roles get a wider band: 1.618/2.618 extensions legitimately
        // clear a tight window's +30%.
        const wide = role === 'target' || role === 'invalidation'
        const floor = wide ? lo * 0.5 : lo * 0.7
        const ceil = wide ? hi * 2.0 : hi * 1.3
        if (!Number.isFinite(price) || price < floor || price > ceil) {
          throw new Error(`${what} ${price} is outside the plausible range for ${args.symbol} @ ${timeframe}: ${range} (tolerance \u00d7${wide ? '0.5..\u00d72.0' : '0.7..\u00d71.3'}). Anchor on prices you actually read \u2014 call market_snapshot or get_ohlcv first and cite real swing points.`)
        }
      }
      const checkConfidence = (confidence: number | undefined, what: string): void => {
        if (confidence !== undefined && (!Number.isFinite(confidence) || confidence < 0 || confidence > 1)) {
          throw new Error(`${what} confidence must be within 0..1`)
        }
      }
      const checkSources = (sources: string[], what: string): string[] => {
        const cleaned = sources.map(s => clean(s, 120)).filter(s => s !== '').slice(0, MAX_SOURCES)
        if (cleaned.length === 0) {
          throw new Error(`${what} has no sources. Every annotation must cite its evidence (e.g. "prior swing high", "Fibonacci 0.618", "round number"). Unsourced annotations are refused.`)
        }
        return cleaned
      }
      const annotations: ChartAnnotation[] = []
      for (const level of args.levels ?? []) {
        const role = (level.role ?? 'other') as AnnotationRole
        const label = clean(level.label, 120)
        checkPrice(level.price, `level '${label}' at`, role)
        checkConfidence(level.confidence, `level '${label}'`)
        annotations.push({
          type: 'level', price: level.price, label, role,
          sources: checkSources(level.sources, `level '${label}'`),
          ...level.confidence !== undefined ? { confidence: level.confidence } : {},
        })
      }
      for (const zone of args.zones ?? []) {
        const role = (zone.role ?? 'other') as AnnotationRole
        const label = clean(zone.label, 120)
        if (!Number.isFinite(zone.low) || !Number.isFinite(zone.high) || zone.low >= zone.high) {
          throw new Error(`zone '${label}': low must be a finite number below high`)
        }
        if (zone.high - zone.low < lastClose * 0.0005) {
          throw new Error(`zone '${label}' is thinner than 0.05% of price \u2014 use a level for a single price`)
        }
        checkPrice(zone.low, `zone '${label}' low`, role)
        checkPrice(zone.high, `zone '${label}' high`, role)
        checkConfidence(zone.confidence, `zone '${label}'`)
        annotations.push({
          type: 'zone', low: zone.low, high: zone.high, label, role,
          sources: checkSources(zone.sources, `zone '${label}'`),
          ...zone.confidence !== undefined ? { confidence: zone.confidence } : {},
        })
      }
      for (const path of args.paths ?? []) {
        const role = (path.role ?? 'other') as AnnotationRole
        const label = clean(path.label, 120)
        const points = path.points ?? []
        if (points.length < 2 || points.length > MAX_PATH_POINTS) {
          throw new Error(`path '${label}' needs 2..${MAX_PATH_POINTS} points`)
        }
        const mapped = points.map((p) => {
          const t = Date.parse(p.time)
          if (!Number.isFinite(t) || t < firstMs || t > lastMs + forwardMs) {
            throw new Error(`path '${label}' point time ${p.time} is outside the drawn window ${candles[0]!.time} \u2026 ${candles[candles.length - 1]!.time} (small forward projection allowed). Use bar-open times you actually read.`)
          }
          checkPrice(p.price, `path '${label}' point at`, role)
          return { time: p.time, price: p.price }
        })
        annotations.push({
          type: 'path', points: mapped, label, role,
          sources: checkSources(path.sources, `path '${label}'`),
        })
      }
      if (annotations.length > MAX_ANNOTATIONS) {
        throw new Error(`too many annotations (${annotations.length} > ${MAX_ANNOTATIONS}): a readable analysis names its few decisive structures`)
      }
      const rawScenarios = args.scenarios ?? []
      if (rawScenarios.length > MAX_SCENARIOS) throw new Error(`too many scenarios (max ${MAX_SCENARIOS})`)
      const scenarios: ChartScenario[] = rawScenarios.map((s) => {
        if (s.triggerPrice !== undefined) checkPrice(s.triggerPrice, 'scenario triggerPrice', 'target')
        if (s.invalidationPrice !== undefined) checkPrice(s.invalidationPrice, 'scenario invalidationPrice', 'invalidation')
        return {
          direction: s.direction as 'bull' | 'bear',
          stance: s.stance as 'base' | 'alternative',
          thesis: clean(s.thesis, 300),
          trigger: clean(s.trigger, 300),
          invalidation: clean(s.invalidation, 300),
          ...s.triggerPrice !== undefined ? { triggerPrice: s.triggerPrice } : {},
          ...s.invalidationPrice !== undefined ? { invalidationPrice: s.invalidationPrice } : {},
        }
      })
      if (annotations.length === 0 && scenarios.length === 0) {
        throw new Error('nothing to annotate: pass at least one level, zone, path, or scenario')
      }
      const tail = chartCandles(candles)
      if (tail === null) throw new Error(`provider '${provider.id}' returned non-finite bars for ${args.symbol} @ ${timeframe}`)
      const chart: ChartTimeframeData = {
        timeframe,
        candles: tail,
        indicators: regimeSnapshot(candles),
        series: chartSeries(regimeSeries(candles)),
        annotations,
      }
      const counts = {
        level: annotations.filter(a => a.type === 'level').length,
        zone: annotations.filter(a => a.type === 'zone').length,
        path: annotations.filter(a => a.type === 'path').length,
      }
      return {
        provider: provider.id,
        symbol: args.symbol,
        timeframe: args.timeframe,
        summary: `Annotated ${args.symbol} @ ${args.timeframe}: ${counts.level} level(s), ${counts.zone} zone(s), ${counts.path} path(s), ${scenarios.length} scenario(s); all prices validated against the last ${candles.length} bars (${lo} \u2026 ${hi}). The chart card renders them.`,
        chart,
        scenarios,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Annotate: ${args.symbol} @ ${args.timeframe}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  const point = {
    type: 'object',
    additionalProperties: false,
    properties: {
      time: { type: 'string', description: 'Bar: a date (YYYY-MM-DD) on daily/weekly charts, the bar-open ISO time on intraday ones.' },
      field: { type: 'string', enum: [...WALK_FIELDS], description: 'What on that bar: high, low, close, volume, or an indicator value.' },
      value: { type: 'number', description: 'The value you are about to say, if any. Checked against the bar.' },
      ahead: { type: 'integer', description: 'Paths only: a projection this many bars past the last one (with price).' },
      price: { type: 'number', description: 'Paths only: the projected price for an ahead point.' },
    },
  } as const

  ctx.tools.register(defineTool({
    name: 'walkthrough',
    description: 'Tell one section of your analysis to the reader on their own chart, the way an analyst sitting beside them would: a few short spoken lines (one or two sentences each), each moving the chart. Circle a bar, draw a level, light up a zone, point at something. Call it once per section, conclusion first; a later section can re-light an earlier mark with focus. Marks are anchored to bars ({ time, field }) and the tool reads the value off the bar, so take the numbers you say from it. A level needs a checkable source or at least a why. End a section with ask (1–3 short replies the reader can tap) to stop and let them answer; then end your turn. Research only: no entries, sizes or recommendations.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframe: { type: 'string', required: true, enum: [...TIMEFRAMES], description: 'The chart this section is told on.' },
      section: { type: 'string', required: true, description: 'Short section title, e.g. "结论", "大背景", "双顶", "接下来".' },
      from: { type: 'string', description: 'First bar the chart frames (date or ISO time). Default: the last 60 bars.' },
      pane: { type: 'string', enum: [...WALK_PANES], description: 'Indicator pane to open under the chart for this section.' },
      marks: {
        type: 'array',
        description: 'What this section draws. Each mark is drawn by the line that talks about it.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            id: { type: 'string', required: true, description: 'Short id, unique in this section; lines and later sections refer to it.' },
            type: { type: 'string', required: true, enum: [...WALK_MARK_TYPES], description: 'circle a bar value; level; zone; path or arrow through bars; span of time.' },
            at: { ...point, description: 'circle: the bar and field to circle.' },
            price: { type: 'number', description: 'level: the price.' },
            low: { type: 'number', description: 'zone: lower edge.' },
            high: { type: 'number', description: 'zone: upper edge.' },
            points: { type: 'array', items: point, description: 'path/arrow: bar points, then optional ahead projections.' },
            from: { type: 'string', description: 'span: first bar.' },
            to: { type: 'string', description: 'span: last bar (default: the latest).' },
            source: {
              type: 'object',
              additionalProperties: false,
              description: 'level: where the price comes from, checked against the bars.',
              properties: {
                field: { type: 'string', required: true, enum: [...WALK_FIELDS] },
                time: { type: 'string', description: 'The bar the value is read on (default: the latest).' },
                stat: { type: 'string', enum: ['min', 'max'], description: 'Lowest/highest field over from…to.' },
                from: { type: 'string' },
                to: { type: 'string' },
              },
            },
            why: { type: 'string', description: 'Plain reason, when no checkable source fits (zones always need one).' },
            label: { type: 'string', description: 'Short caption on the chart.' },
            tone: { type: 'string', enum: ['up', 'down', 'neutral'], description: 'up/down for bull/bear signals; neutral otherwise.' },
            role: { type: 'string', description: 'Accepted for annotate_chart habits: support reads as tone up, resistance as down. Prefer tone.' },
            pane: { type: 'string', enum: ['price', 'volume', 'indicator'], description: 'level: which pane (default price).' },
            keep: { type: 'boolean', description: 'Leave it faintly on the chart for later sections (the key zone of a conclusion).' },
          },
        },
      },
      lines: {
        type: 'array',
        required: true,
        description: 'What you say, in order. Spoken, first person, one or two sentences each.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            say: { type: 'string', required: true, description: 'The line. Wrap the words a mark explains as [[markId|words]].' },
            draw: { type: 'array', items: { type: 'string' }, description: 'Ids of this section\'s marks to draw as you say it.' },
            point: { type: 'string', description: 'Mark id to point at (this or an earlier section).' },
            pointAt: { ...point, description: 'Or point at a bar value without drawing.' },
            focus: { type: 'string', description: 'Re-light a mark from an earlier section, e.g. the conclusion\'s zone.' },
            volume: { type: 'array', items: { type: 'string' }, description: 'Bars whose volume to spotlight (the rest dim).' },
          },
        },
      },
      ask: { type: 'array', items: { type: 'string' }, description: '1–3 short replies the reader can tap after the last line. Then end your turn.' },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          summary: { type: 'string', required: true },
          walkthrough: { type: 'json', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.summary }],
      presentationMeta: (_args, value) => value.walkthrough as WalkthroughPayload,
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const candles = await provider.getOhlcv({ symbol: args.symbol, timeframe: args.timeframe as Timeframe, limit: 400 })
      if (candles.length === 0) throw new Error(`no candles for ${args.symbol} @ ${args.timeframe}`)
      const { payload, summary } = resolveWalkthrough(args as unknown as WalkthroughArgs, candles, provider.id)
      return { summary, walkthrough: payload }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Walkthrough: ${args.section}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'cross_asset',
    description:
      'Read one instrument through another — a ratio (HG=F/GC=F copper-in-gold, GC=F/SI=F gold-in-silver) '
      + 'or a single instrument\'s own level. Returns the latest value, the change over the window, and where '
      + 'that value sits in its OWN history (percentile), because a ratio has no meaning without its range. '
      + 'Legs are joined on bar time, so mismatched calendars shrink the sample rather than shift it. '
      + 'In this framework the cross-asset leg is a VETO, not a trigger: it can argue against a setup but '
      + 'never starts one, and a stretched ratio can stay stretched.',
    parameters: {
      numerator: { type: 'string', required: true, description: 'The leg being priced, e.g. HG=F (copper).' },
      denominator: { type: 'string', description: 'The leg doing the pricing, e.g. GC=F (gold). Omit to read the numerator alone.' },
      timeframe: { type: 'string', required: true, description: 'Bar interval both legs are read on.', enum: [...TIMEFRAMES] },
      bars: { type: 'integer', description: 'How many bars of history to compare over (default 250, max 2000).' },
      scale: { type: 'number', description: 'Display multiplier for the ratio, printed with the value (e.g. 1000 turns copper-in-gold 0.0015 into 1.506). Default 1.' },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          pair: { type: 'string', required: true },
          mode: { type: 'string', required: true },
          timeframe: { type: 'string', required: true },
          bars: { type: 'integer', required: true },
          droppedBars: { type: 'integer', required: true },
          // from/to/first/min/max are part of the result: a percentile without the
          // window it was measured over is the kind of number this project refuses.
          from: { type: 'string', required: true },
          to: { type: 'string', required: true },
          first: { type: 'number', required: true },
          min: { type: 'number', required: true },
          max: { type: 'number', required: true },
          latest: { type: 'number', required: true },
          changePct: { type: 'number', required: true },
          percentile: { type: 'number', required: true },
          thin: { type: 'boolean', required: true },
          scale: { type: 'number', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text as string }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const limit = Math.min(MAX_OHLCV_BARS, Math.max(2, args.bars ?? 250))
      const timeframe = args.timeframe as Timeframe
      const numeratorCandles = await provider.getOhlcv({ symbol: args.numerator, timeframe, limit })
      if (numeratorCandles.length === 0) throw new Error(`no candles for ${args.numerator} @ ${timeframe}`)
      const denominatorCandles = args.denominator === undefined
        ? undefined
        : await provider.getOhlcv({ symbol: args.denominator, timeframe, limit })
      if (denominatorCandles !== undefined && denominatorCandles.length === 0) {
        throw new Error(`no candles for ${args.denominator} @ ${timeframe}`)
      }
      const { points, dropped } = joinLegs(
        { symbol: args.numerator, candles: numeratorCandles },
        denominatorCandles === undefined ? undefined : { symbol: args.denominator!, candles: denominatorCandles },
      )
      const pair = args.denominator === undefined ? args.numerator : `${args.numerator}/${args.denominator}`
      const scale = args.scale === undefined || args.scale <= 0 ? 1 : args.scale
      const result = describeCrossAsset(points, pair, args.denominator === undefined ? 'level' : 'ratio', timeframe, scale)
      const described = { ...result, droppedBars: dropped }
      return { ...described, text: renderCrossAsset(described) }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Cross-asset: ${args.denominator === undefined ? args.numerator : `${args.numerator}/${args.denominator}`}`,
      kind: 'read',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'resolve_contract',
    description:
      'Which named futures contract is a continuous series like CL=F actually quoting right now, and when did it '
      + 'last roll? A continuous series is a splice of front months: price levels stop being comparable across a '
      + 'roll, and a roll gap looks like a move that never happened (on 2026-11-19 CL=F showed +0.07% while both '
      + 'its Dec and Jan contracts rose ~1.22%). The provider label is not trustworthy either — it still said '
      + '"Crude Oil Dec 26" while the series tracked January — so this tool identifies the contract by matching '
      + 'prices against the named months, scans the recent history for the switch date, and reports the roll gap. '
      + 'Run it before quoting any price level from a =F symbol.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Continuous futures symbol, e.g. CL=F or GC=F.' },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', required: true },
          root: { type: 'string', required: true },
          active: { type: 'json', required: true },
          rolledOn: { type: 'json', required: true },
          candidates: { type: 'json', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text as string }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const symbol = args.symbol
      const root = continuousRoot(symbol)
      if (root === null) {
        throw new Error(`${symbol} is not a continuous symbol (expected the XXX=F form); a named contract already identifies itself`)
      }
      const continuous = await provider.getOhlcv({ symbol, timeframe: '1d', limit: 40 })
      if (continuous.length === 0) throw new Error(`no candles for ${symbol}`)

      // Try each venue until one answers with usable history.
      const months = candidateMonths(new Date(), 4)
      const tried: { symbol: string; candles: Awaited<ReturnType<typeof provider.getOhlcv>> }[] = []
      for (const exchange of exchangesFor(root)) {
        for (const month of months) {
          const named = contractSymbol(root, month, exchange)
          try {
            const candles = await provider.getOhlcv({ symbol: named, timeframe: '1d', limit: 40 })
            if (candles.length > 0) tried.push({ symbol: named, candles })
          } catch {
            // A venue that does not list this root simply contributes nothing.
          }
        }
        if (tried.length >= 2) break
      }
      if (tried.length === 0) throw new Error(`no named contracts resolved for ${root} on any known venue`)

      const byTime = tried.map(t => ({ symbol: t.symbol, closes: new Map(t.candles.map(c => [c.time, c.close])) }))
      const matches: (string | null)[] = []
      const times: string[] = []
      for (const bar of continuous) {
        const named = byTime.map(t => ({ symbol: t.symbol, close: t.closes.get(bar.time) ?? NaN }))
          .filter(n => Number.isFinite(n.close))
        const hit = matchContract(bar.close, named)
        matches.push(hit === null ? null : hit.symbol)
        times.push(bar.time)
      }
      const lastBar = continuous[continuous.length - 1]!
      const activeNamed = byTime.map(t => ({ symbol: t.symbol, close: t.closes.get(lastBar.time) ?? NaN }))
        .filter(n => Number.isFinite(n.close))
      const active = matchContract(lastBar.close, activeNamed)
      const roll = lastRoll(matches, times)

      const candidates = activeNamed.map(n => ({
        symbol: n.symbol,
        close: n.close,
        diffPct: active !== null && n.symbol === active.symbol
          ? active.diffPct
          : Number((((n.close - lastBar.close) / lastBar.close) * 100).toFixed(3)),
      }))
      const gap = active === null || candidates.length < 2
        ? null
        : (() => {
            const other = candidates.filter(c => c.symbol !== active.symbol)[0]
            return other === undefined ? null : Number((active.close - other.close).toFixed(3))
          })()
      const lines = [
        `${symbol} (${root}) last close ${lastBar.close} at ${lastBar.time.slice(0, 10)}`,
        active === null
          ? 'active contract: UNRESOLVED — no named month matched within 0.25%; treat every price level on this series as unverified'
          : `active contract: ${active.symbol} (diff ${active.diffPct}%)`,
        roll === null
          ? 'roll in the window: none — the tracked contract did not change in the last 40 bars'
          : `LAST ROLL: ${roll.date} ${roll.from} -> ${roll.to}. Bars before that date belong to ${roll.from}, so levels minted there are NOT comparable with prices after it`,
        gap === null ? 'roll gap: unknown (needs two candidates)' : `current spread vs the neighbouring month: ${gap} (about ${((Math.abs(gap) / lastBar.close) * 100).toFixed(2)}% of price)`,
        ...candidates.map(c => `  ${c.symbol.padEnd(12)} ${c.close} (${c.diffPct > 0 ? '+' : ''}${c.diffPct}% vs continuous)`),
        `candidate months tested: ${months.map(m => monthLabel(m)).join(', ')}`,
        'rule: use the continuous series for direction and shape; quote price levels from the ACTIVE contract.',
      ]
      return {
        symbol,
        root,
        active,
        rolledOn: roll,
        candidates,
        text: lines.join('\n'),
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Contract: ${args.symbol}`,
      kind: 'read',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'audit_energy_decay',
    description:
      'Test his one quantified claim instead of repeating it: after a break, price releases its strongest energy '
      + 'within 5-10 bars and rarely beyond. Finds confirmed fractal swings, takes the first bar that CLOSES '
      + 'beyond one, measures where the favourable excursion peaks over a fixed horizon, and reports the '
      + 'distribution. Tri-state and allowed to be NOT_PROVEN: under 30 events the sample cannot support a '
      + 'conclusion. Deterministic — no LLM grades anything. Tests where the move peaked, NOT whether a target '
      + 'would have filled first; the blind spots print with every result.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframe: { type: 'string', required: true, description: 'Bar interval to test on.', enum: [...TIMEFRAMES] },
      bars: { type: 'integer', description: 'Bars of history to scan (default 500, max 2000).' },
      horizon: { type: 'integer', description: 'Forward bars to measure the excursion peak (default 20).' },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', required: true },
          timeframe: { type: 'string', required: true },
          bars: { type: 'integer', required: true },
          horizon: { type: 'integer', required: true },
          events: { type: 'integer', required: true },
          medianPeakBar: { type: 'number', required: true },
          meanPeakBar: { type: 'number', required: true },
          shareWithin5to10: { type: 'number', required: true },
          shareBeyond10: { type: 'number', required: true },
          shareBefore5: { type: 'number', required: true },
          medianPeakAtr: { type: 'number', required: true },
          verdict: { type: 'string', required: true },
          headline: { type: 'string', required: true },
          blindSpots: { type: 'json', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text as string }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const limit = Math.min(MAX_OHLCV_BARS, Math.max(60, args.bars ?? 500))
      const candles = await provider.getOhlcv({ symbol: args.symbol, timeframe: args.timeframe as Timeframe, limit })
      if (candles.length === 0) throw new Error(`no candles for ${args.symbol} @ ${args.timeframe}`)
      const result = energyDecay(args.symbol, args.timeframe, candles, args.horizon ?? DEFAULT_HORIZON)
      return { ...result, text: renderEnergyDecay(result) }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Energy decay: ${args.symbol} ${args.timeframe}`,
      kind: 'read',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'market_channel',
    description:
      'Fit a price channel rather than asking anyone to draw one. The midline is a least-squares regression of close '
      + 'on bar index and the rails sit at two standard deviations of the residuals, so every bar votes and the rails '
      + 'move with the fit instead of being anchored to two hand-picked pivots. Reports R-squared (a channel is a '
      + 'claim that price travels in a direction, and R-squared measures that claim), the close\'s position between '
      + 'the rails (0% lower, 100% upper), slope in price and percent per bar, width as a percent of close, how many '
      + 'swings sit near each rail, width versus the preceding window of the same length (sigma bands can breathe, so '
      + 'a narrowing channel is a comparison), and recent closes outside a rail with whether they came back. Returns '
      + 'status insufficient when R-squared is under 0.3: a range is not a channel.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframe: { type: 'string', required: true, description: 'Bar interval to fit on.', enum: [...TIMEFRAMES] },
      bars: { type: 'integer', description: 'Window to fit (default 120, max 2000).' },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', required: true },
          timeframe: { type: 'string', required: true },
          close: { type: 'number', required: true },
          status: { type: 'string', required: true },
          r2: { type: 'number', required: true },
          slopePerBar: { type: 'number', required: true },
          slopePctPerBar: { type: 'number', required: true },
          upper: { type: 'number', required: true },
          lower: { type: 'number', required: true },
          widthPct: { type: 'number', required: true },
          positionPct: { type: 'number', required: true },
          narrowing: { type: 'json', required: true },
          breaks: { type: 'json', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text as string }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const limit = Math.min(MAX_OHLCV_BARS, Math.max(30, args.bars ?? DEFAULT_CHANNEL_BARS))
      const candles = await provider.getOhlcv({ symbol: args.symbol, timeframe: args.timeframe as Timeframe, limit })
      if (candles.length === 0) throw new Error(`no candles for ${args.symbol} @ ${args.timeframe}`)
      const close = candles[candles.length - 1]!.close
      const channel = channelOf(candles, { bars: limit })
      return {
        symbol: args.symbol,
        timeframe: args.timeframe,
        close,
        status: channel.status,
        r2: channel.r2,
        slopePerBar: channel.slopePerBar,
        slopePctPerBar: channel.slopePctPerBar,
        upper: channel.upper,
        lower: channel.lower,
        widthPct: channel.widthPct,
        positionPct: channel.positionPct,
        narrowing: channel.narrowing,
        breaks: channel.breaks,
        text: `${args.symbol} @ ${args.timeframe}\n${renderChannel(channel, close)}`,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Channel: ${args.symbol} ${args.timeframe}`,
      kind: 'read',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'judge_setup',
    description:
      'Adjudicate a trade you have proposed — it never invents one. Supply direction, entry, invalidation and at '
      + 'least one target, and it gates them the way the framework does: Entry/Stop/Target must arrive together, '
      + 'timeframe alignment may only forbid, the regime decides whether an extreme means continuation or '
      + 'mean-reversion, the entry must sit at confirmed structure rather than adrift, and reward:risk must clear '
      + '1:1 at the first target. Cross-asset can veto only under a threshold YOU supply. What the framework has '
      + 'and this tool cannot evaluate (打點, 選美, Ariston Channel, 主力 flow) is reported as UNKNOWN, never as a '
      + 'pass, and a substantive UNKNOWN forces STAND ASIDE. Targets are yours: his T1/T2/T3 derivation is '
      + 'unpublished and this tool will not fake it.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframe: { type: 'string', required: true, description: 'Bar interval the proposal is judged on.', enum: [...TIMEFRAMES] },
      direction: { type: 'string', required: true, description: 'Proposed side.', enum: ['long', 'short'] },
      entry: { type: 'number', required: true, description: 'Proposed entry price.' },
      invalidation: { type: 'number', required: true, description: 'The price that would prove the read wrong (a price, never a percentage).' },
      targets: { type: 'array', required: true, description: 'One to three target prices, T1 first.', items: { type: 'number' } },
      higherTimeframe: { type: 'string', description: 'Second timeframe for the alignment gate (e.g. 1w when judging 1d). Omit to skip that gate.' },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', required: true },
          timeframe: { type: 'string', required: true },
          close: { type: 'number', required: true },
          verdict: { type: 'string', required: true },
          reason: { type: 'string', required: true },
          atr: { type: 'json', required: true },
          riskReward: { type: 'json', required: true },
          gates: { type: 'json', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text as string }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const timeframe = args.timeframe as Timeframe
      const candles = await provider.getOhlcv({ symbol: args.symbol, timeframe, limit: 300 })
      if (candles.length === 0) throw new Error(`no candles for ${args.symbol} @ ${timeframe}`)
      const higher = args.higherTimeframe === undefined
        ? undefined
        : await provider.getOhlcv({ symbol: args.symbol, timeframe: args.higherTimeframe as Timeframe, limit: 300 })
      const review = reviewSetup({
        symbol: args.symbol,
        timeframe,
        candles,
        higherTimeframe: higher,
        proposal: {
          direction: args.direction as 'long' | 'short',
          entry: args.entry,
          invalidation: args.invalidation,
          targets: (args.targets as number[]) ?? [],
        },
      })
      return { ...review, text: renderSetup(review) }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Judge setup: ${args.symbol} ${args.direction}`,
      kind: 'other',
      rawInput: args,
    }),
  }))

  ctx.tools.register(defineTool({
    name: 'market_structure',
    description:
      'Locate the structure that already printed: confirmed fractal swing highs/lows, the nearest level on each '
      + 'side of the close with its distance, range width and least-squares slope over 20/50/100 bars, and the '
      + 'most recent failed break (price pierced a level then closed back inside — his 假突破). '
      + 'Every level states how it was found, because a support number without provenance is an opinion. '
      + 'A swing needs 3 bars on each side that did not exceed it, so a level can never exist in the last 3 bars: '
      + 'that is lookahead, not structure. Nothing here is projected — no targets, no measured moves.',
    parameters: {
      symbol: { type: 'string', required: true, description: 'Instrument symbol exactly as list_symbols reports it.' },
      timeframe: { type: 'string', required: true, description: 'Bar interval to read structure on.', enum: [...TIMEFRAMES] },
      bars: { type: 'integer', description: 'Bars to read (default 300, max 2000). More bars means older swings.' },
      provider: { type: 'string', description: 'Provider id. Omit to use the default provider.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          symbol: { type: 'string', required: true },
          timeframe: { type: 'string', required: true },
          close: { type: 'number', required: true },
          resistance: { type: 'json', required: true },
          support: { type: 'json', required: true },
          failedBreak: { type: 'json', required: true },
          text: { type: 'string', required: true },
        },
      },
      render: (_args, value) => [{ type: 'text', text: value.text as string }],
    },
    isConcurrencySafe: () => true,
    async execute(args, _exec) {
      const provider = ctx.marketData.provider(args.provider)
      const limit = Math.min(MAX_OHLCV_BARS, Math.max(20, args.bars ?? 300))
      const candles = await provider.getOhlcv({
        symbol: args.symbol,
        timeframe: args.timeframe as Timeframe,
        limit,
      })
      if (candles.length === 0) throw new Error(`no candles for ${args.symbol} @ ${args.timeframe}`)
      const report = structureReport(candles, args.timeframe)
      return {
        symbol: args.symbol,
        timeframe: args.timeframe,
        close: report.close,
        resistance: report.resistance,
        support: report.support,
        failedBreak: report.failedBreak,
        text: `${args.symbol} @ ${renderStructure(report)}`,
      }
    },
    presentCall: args => ({
      card: 'generic',
      title: `Structure: ${args.symbol} ${args.timeframe}`,
      kind: 'read',
      rawInput: args,
    }),
  }))
}
