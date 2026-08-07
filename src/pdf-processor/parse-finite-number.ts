/**
 * Parse a config/env value into a finite number, falling back when invalid.
 * Unlike `Math.max(min, Number(x))`, this never returns NaN.
 */
export function parseFiniteNumber(
  value: unknown,
  fallback: number,
  options?: { min?: number; max?: number },
): number {
  const n = typeof value === 'number' ? value : Number(value);
  const base = Number.isFinite(n) ? n : fallback;
  let out = base;
  if (options?.min != null) out = Math.max(options.min, out);
  if (options?.max != null) out = Math.min(options.max, out);
  return out;
}
