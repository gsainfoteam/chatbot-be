import { maskPersonalInfo } from './notice-text';
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { McpToolClient } from '../../../../mcp/mcp-tool-client';

export type ZiggleNoticeSummary = {
  id: number;
  title: string;
  /** Ziggle 자동 요약. 크롤링 공지는 아직 비어 있을 수 있다. */
  summary: string | null;
};

export const DEFAULT_ZIGGLE_MCP_TIMEOUT_MS = 5_000;
export const DEFAULT_ZIGGLE_NOTICE_URL_BASE =
  'https://ziggle.gistory.me/notice/';

/**
 * Ziggle MCP(`search_notices`, `get_notice`) 래퍼.
 * MCP 응답 형식은 Ziggle 쪽 계약 그대로 쓰고, 형식이 다르면 오류로 본다.
 */
@Injectable()
export class ZiggleNoticeClient {
  private readonly logger = new Logger(ZiggleNoticeClient.name);
  private readonly client: McpToolClient | null;
  private readonly noticeUrlBase: string;
  /** null = 모든 위젯 허용(`*`) */
  private readonly widgetKeyIds: ReadonlySet<string> | null;

  constructor(configService: ConfigService) {
    const url = configService.get<string>('ZIGGLE_MCP_URL')?.trim();
    const apiKey = configService.get<string>('ZIGGLE_MCP_API_KEY')?.trim();
    const timeoutMs = Number(configService.get('ZIGGLE_MCP_TIMEOUT_MS'));

    this.client =
      url && apiKey
        ? new McpToolClient({
            name: 'ziggle',
            url,
            headers: { 'x-api-key': apiKey },
            timeoutMs:
              Number.isInteger(timeoutMs) && timeoutMs > 0
                ? timeoutMs
                : DEFAULT_ZIGGLE_MCP_TIMEOUT_MS,
          })
        : null;

    const base =
      configService.get<string>('ZIGGLE_NOTICE_URL_BASE')?.trim() ||
      DEFAULT_ZIGGLE_NOTICE_URL_BASE;
    this.noticeUrlBase = base.endsWith('/') ? base : `${base}/`;

    const ids = (
      configService.get<string>('ZIGGLE_NOTICE_WIDGET_KEY_IDS') ?? ''
    )
      .split(',')
      .map((id) => id.trim())
      .filter(Boolean);
    this.widgetKeyIds = ids.includes('*') ? null : new Set(ids);
  }

  /**
   * 이 위젯에서 공지를 쓸 수 있는지. Ziggle MCP에는 공지별 공개 범위가 없으므로
   * GIST 구성원 대상 위젯에만 켠다.
   */
  isEnabledFor(widgetKeyId: string | undefined): boolean {
    if (!this.client) return false;
    if (this.widgetKeyIds === null) return true;
    return widgetKeyId != null && this.widgetKeyIds.has(widgetKeyId);
  }

  noticeUrl(id: number): string {
    return `${this.noticeUrlBase}${id}`;
  }

  async searchNotices(
    query: string,
    limit: number,
  ): Promise<ZiggleNoticeSummary[]> {
    const result = await this.requireClient().callTool('search_notices', {
      query,
      limit,
    });
    if (result.isError) {
      throw new Error(`Ziggle search_notices failed: ${result.text}`);
    }
    const parsed: unknown = JSON.parse(result.text);
    if (!Array.isArray(parsed)) {
      throw new Error('Ziggle search_notices returned a non-array');
    }
    return parsed.flatMap((item: unknown) => {
      if (!item || typeof item !== 'object') return [];
      const { id, title, summary } = item as Record<string, unknown>;
      if (typeof id !== 'number' || typeof title !== 'string') return [];
      return [
        {
          id,
          title: maskPersonalInfo(title),
          summary:
            typeof summary === 'string' && summary.trim()
              ? maskPersonalInfo(summary).slice(0, 4000)
              : null,
        },
      ];
    });
  }

  /** 공지 원문(크롤링한 HTML). 없는 공지면 null */
  async getNoticeBody(id: number): Promise<string | null> {
    const result = await this.requireClient().callTool('get_notice', { id });
    if (result.isError) {
      this.logger.debug(`Ziggle get_notice(${id}) error: ${result.text}`);
      return null;
    }
    const parsed = JSON.parse(result.text) as { body?: unknown };
    return typeof parsed.body === 'string' ? parsed.body : null;
  }

  private requireClient(): McpToolClient {
    if (!this.client) throw new Error('Ziggle MCP is not configured');
    return this.client;
  }
}
