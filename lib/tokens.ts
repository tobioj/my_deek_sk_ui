// Token estimates and cost. Prices are USD per 1M tokens at off-peak rates;
// peak hours cost double. Source: https://api-docs.deepseek.com/quick_start/pricing
import type { ModelId, Usage } from "./types";

const PRICES: Record<ModelId, { cacheHit: number; cacheMiss: number; output: number }> = {
  "deepseek-flash": { cacheHit: 0.003, cacheMiss: 0.15, output: 0.6 },
  "deepseek-v4-pro": { cacheHit: 0.022, cacheMiss: 0.66, output: 1.98 },
};

// Peak: 01:00–04:00 and 06:00–10:00 UTC, Monday to Friday.
export function isPeak(date = new Date()): boolean {
  const day = date.getUTCDay();
  if (day === 0 || day === 6) return false;
  const h = date.getUTCHours();
  return (h >= 1 && h < 4) || (h >= 6 && h < 10);
}

export function costOf(model: ModelId, u: Pick<Usage, "cacheHitTokens" | "cacheMissTokens" | "completionTokens">, when = new Date()): number {
  const p = PRICES[model];
  const mult = isPeak(when) ? 2 : 1;
  return ((u.cacheHitTokens * p.cacheHit + u.cacheMissTokens * p.cacheMiss + u.completionTokens * p.output) / 1_000_000) * mult;
}

// Rough estimate (~4 characters per token for English and code) for text not yet sent.
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

export function formatTokens(n: number): string {
  if (n < 1000) return String(n);
  if (n < 1_000_000) return `${(n / 1000).toFixed(n < 10_000 ? 1 : 0)}K`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

export function formatCost(usd: number): string {
  if (usd === 0) return "$0";
  if (usd < 0.01) return `$${usd.toFixed(4)}`;
  return `$${usd.toFixed(2)}`;
}
