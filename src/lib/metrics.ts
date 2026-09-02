// Pure shaping for `agent automation metrics`: the API returns one sample per
// finished session (duration, cost, tokens) and the trailing spend windows;
// the table wants medians and a short duration.

export interface MetricSample {
  duration_seconds: number
  cost: number
  tokens_total: number
}

export interface SampleSummary {
  count: number
  duration_seconds_p50: number | null
  cost_millicents_p50: number | null
  tokens_p50: number | null
}

// The nearest-rank percentile of a list; null when there is nothing to rank.
export function percentile(values: number[], p: number): number | null {
  if (values.length === 0) return null
  const sorted = [...values].sort((a, b) => a - b)
  const rank = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1))
  return sorted[rank]!
}

export function summarizeSamples(samples: MetricSample[]): SampleSummary {
  return {
    count: samples.length,
    duration_seconds_p50: percentile(
      samples.map((s) => s.duration_seconds),
      50,
    ),
    cost_millicents_p50: percentile(
      samples.map((s) => s.cost),
      50,
    ),
    tokens_p50: percentile(
      samples.map((s) => s.tokens_total),
      50,
    ),
  }
}

// "45s", "3m 12s", "1h 04m": enough precision for a session length.
export function formatSeconds(seconds: number): string {
  const total = Math.max(0, Math.round(seconds))
  if (total < 60) return `${total}s`
  const minutes = Math.floor(total / 60)
  if (minutes < 60) return `${minutes}m ${String(total % 60).padStart(2, '0')}s`
  const hours = Math.floor(minutes / 60)
  return `${hours}h ${String(minutes % 60).padStart(2, '0')}m`
}
