import {
  PAGE_START,
  pageImageObjectPath,
} from '../../pdf-processor/page-image-reference';
import type { ResourceInfo } from './resource-content.service';

export type PageImageCandidate = {
  objectPath: string;
  description: string;
  context: string;
};

const PAGE_IMAGE_REFERENCE = /!\[([^\]]*)\]\(IMAGE:page-(\d+)\)/g;
const NOT_CONTENT = /[^\p{L}\p{N}]+/gu;
const MAX_CONTEXT_CHARS = 1_500;
const MAX_IMAGES = 2;
/** Fewer shared bigrams than this is a coincidence of common words. */
const MIN_SHARED_BIGRAMS = 3;
/** Share of the shorter text that must appear in the longer one. */
const MIN_COVERAGE = 0.25;
/** A cover page also matches a little; only keep images close to the best one. */
const MIN_SHARE_OF_BEST = 0.5;

/** The answering LLM gets the description only, so it cannot echo the syntax. */
export function stripPageImageReferences(content: string): string {
  return content.replace(PAGE_IMAGE_REFERENCE, '$1').replaceAll(PAGE_START, '');
}

export function extractPageImages(
  content: string,
  chunkPath: string,
): PageImageCandidate[] {
  const resourceName = chunkPath.split('/')[0];
  const candidates: PageImageCandidate[] = [];
  let contextStart = 0;

  for (const match of content.matchAll(PAGE_IMAGE_REFERENCE)) {
    candidates.push({
      objectPath: pageImageObjectPath(resourceName, Number(match[2])),
      description: match[1],
      context: content
        .slice(contextStart, match.index)
        .split(PAGE_START)
        .pop()!
        .slice(-MAX_CONTEXT_CHARS),
    });
    contextStart = match.index + match[0].length;
  }
  return candidates;
}

function bigrams(text: string): Set<string> {
  const content = text.normalize('NFC').replace(NOT_CONTENT, '').toLowerCase();
  const grams = new Set<string>();
  for (let i = 0; i < content.length - 1; i += 1) {
    grams.add(content.slice(i, i + 2));
  }
  return grams;
}

/**
 * Picks the images whose page text the answer draws on, so a reader can check
 * the answer against the source. Anything unrelated in the same chunk stays out.
 */
export function selectPageImageResources(
  answer: string,
  question: string,
  candidates: PageImageCandidate[],
): ResourceInfo[] {
  const said = bigrams(`${answer} ${question}`);
  const best = new Map<
    string,
    { candidate: PageImageCandidate; score: number }
  >();

  for (const candidate of candidates) {
    const page = bigrams(`${candidate.description} ${candidate.context}`);
    let shared = 0;
    for (const gram of page) {
      if (said.has(gram)) shared += 1;
    }
    const coverage = shared / Math.max(1, Math.min(said.size, page.size));
    if (shared < MIN_SHARED_BIGRAMS || coverage < MIN_COVERAGE) continue;

    // Dice similarity: a long page that merely mentions the topic shares many
    // bigrams, but scores below a page that mostly consists of the answer.
    const score = (2 * shared) / (said.size + page.size);
    const known = best.get(candidate.objectPath);
    if (!known || score > known.score) {
      best.set(candidate.objectPath, { candidate, score });
    }
  }

  const ranked = [...best.values()].sort((a, b) => b.score - a.score);
  return ranked
    .filter((entry) => entry.score >= ranked[0].score * MIN_SHARE_OF_BEST)
    .slice(0, MAX_IMAGES)
    .map(({ candidate }) => ({
      path: candidate.description,
      formats: ['png'],
      url: candidate.objectPath.split('/').map(encodeURIComponent).join('/'),
    }));
}
