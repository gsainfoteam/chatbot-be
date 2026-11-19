import { maskPersonalInfo } from '../agent/tools/ziggle/notice-text';
import type { ExternalSource } from '../agent/agent.types';

export function safeSources(sources: ExternalSource[]): ExternalSource[] {
  const byUrl = new Map<string, ExternalSource>();
  for (const source of sources) {
    try {
      const url = new URL(source.url);
      if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password
      )
        continue;
      if (maskPersonalInfo(source.url) !== source.url) continue;
      byUrl.set(source.url, {
        ...source,
        title: maskPersonalInfo(source.title),
      });
    } catch {
      /* Invalid source URLs never become links. */
    }
  }
  return [...byUrl.values()];
}

/** The model emits opaque citation IDs; only the server supplies URLs and labels. */
export function citationInstructions(sources: ExternalSource[]): string {
  if (!sources.length) return '';
  return (
    '\n\n[출처 인용 계약]\n공지·외부 자료를 근거로 쓴 문장에는 아래 [cite:N] 표지를 붙이세요. URL이나 마크다운 링크를 직접 만들지 마세요. 실제로 사용한 출처만 인용하세요. 표지는 서버가 링크로 바꿉니다.\n' +
    sources.map((s, i) => `[cite:${i + 1}] ${s.title} (${s.url})`).join('\n')
  );
}

/** Holds incomplete numbers, links and citations across provider SSE chunk boundaries. */
export class AnswerOutputFilter {
  private pending = '';
  private readonly cited = new Set<string>();
  readonly sources: ExternalSource[];
  constructor(sources: ExternalSource[] = []) {
    this.sources = safeSources(sources);
  }

  push(text: string, final = false): string {
    this.pending += text
      .normalize('NFKC')
      .replace(/[\u200b-\u200f\u2060\ufeff]/g, '');
    let cut = final
      ? this.pending.length
      : Math.max(0, this.pending.length - 128);
    if (!final) {
      // Never split a number-like run (including international and spaced numbers).
      for (const match of this.pending.matchAll(/[+\d][\d\s().+-]*/g)) {
        if (match.index < cut && match.index + match[0].length > cut)
          cut = match.index;
      }
      for (const match of this.pending.matchAll(
        /\[[^\]\n]*\](?:\([^\n)]*\)?)?|\[[^\]\n]*$|https?:\/\/\S*/g,
      )) {
        if (match.index < cut && match.index + match[0].length > cut)
          cut = match.index;
      }
    }
    // A malformed unclosed link or numeric run cannot grow memory indefinitely.
    if (!final && !cut && this.pending.length > 8192) {
      this.pending = '';
      return '[안전하게 표시할 수 없는 긴 항목 생략]';
    }
    const ready = this.pending.slice(0, cut);
    this.pending = this.pending.slice(cut);
    return this.render(ready);
  }

  usedSources(): ExternalSource[] {
    return this.sources.filter((s) => this.cited.has(s.url));
  }

  private render(text: string): string {
    const replacements: string[] = [];
    const link = (source: ExternalSource): string => {
      this.cited.add(source.url);
      const title = source.title.replace(/[[\]\\\r\n]/g, ' ');
      const url = source.url.replace(/\(/g, '%28').replace(/\)/g, '%29');
      replacements.push(`[${title}](${url})`);
      return `\ue000${replacements.length - 1}\ue000`;
    };
    let result = text
      .replace(/\ue000/g, '')
      .replace(/\[cite:(\d+)\]/g, (_, id: string) => {
        const source = this.sources[Number(id) - 1];
        return source ? link(source) : '';
      });
    result = result.replace(
      /\[([^\]\n]*)\]\(([^\n)]*)\)/g,
      (_, label: string, url: string) => {
        const source = this.sources.find((s) => s.url === url);
        return source ? link(source) : label;
      },
    );
    result = result.replace(/https?:\/\/[^\s<>\]]+/g, (url) => {
      const source = this.sources.find((s) => s.url === url);
      return source ? link(source) : '[확인되지 않은 링크 생략]';
    });
    result = maskPersonalInfo(result).replace(/\[cite:[^\]\n]*(?:\]|$)/g, '');
    return result.replace(
      /\ue000(\d+)\ue000/g,
      (_, i: string) => replacements[Number(i)] ?? '',
    );
  }
}
