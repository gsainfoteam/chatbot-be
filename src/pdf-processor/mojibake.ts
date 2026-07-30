/**
 * Mojibake recovery for Korean UTF-8 text incorrectly decoded as CP1252/Latin-1.
 * Ported from ziggle-mcp processor/worker.py
 */
import iconv from 'iconv-lite';

const MOJIBAKE_INDICATORS = new Set('íìëêéèãâáàäåñóòôöùûüý');

/**
 * Detect if text appears to be UTF-8 Korean mojibake (decoded as Latin-1).
 */
export function isLikelyMojibake(text: string): boolean {
  if (!text || text.trim().length < 10) {
    return false;
  }
  const trimmed = text.trim();
  let indicatorCount = 0;
  for (const c of trimmed) {
    if (MOJIBAKE_INDICATORS.has(c)) indicatorCount += 1;
  }
  return indicatorCount / trimmed.length > 0.08;
}

/**
 * Try to recover UTF-8 text that was incorrectly decoded as CP1252/Latin-1.
 * Returns recovered text if Korean was found, otherwise null.
 */
export function tryFixMojibake(text: string): string | null {
  if (!text || !text.trim()) {
    return null;
  }

  for (const encoding of ['win1252', 'latin1'] as const) {
    try {
      const bytes = iconv.encode(text, encoding);
      const recovered = bytes.toString('utf8');
      let koreanCount = 0;
      for (const c of recovered) {
        const code = c.codePointAt(0) ?? 0;
        if (code >= 0xac00 && code <= 0xd7a3) koreanCount += 1;
      }
      if (koreanCount > 0) {
        return recovered;
      }
    } catch {
      // try next encoding
    }
  }
  return null;
}

/**
 * Apply mojibake fix when detected; otherwise return original text.
 * If mojibake is detected but recovery fails, returns empty string (skip bad text).
 */
export function normalizeExtractedText(rawText: string): string {
  if (!isLikelyMojibake(rawText)) {
    return rawText;
  }
  const fixed = tryFixMojibake(rawText);
  return fixed ?? '';
}
