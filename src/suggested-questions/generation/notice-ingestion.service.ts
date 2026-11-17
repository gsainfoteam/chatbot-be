import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ZiggleNoticeSummary } from '../../chat/agent/tools/ziggle/ziggle-notice.client';
import { SuggestedQuestionsRepository } from '../suggested-questions.repository';
import { NoticeFeedService } from './notice-feed.service';

export const DEFAULT_MAX_NOTICES_PER_RUN = 10;

export interface NoticeIngestionResult {
  widgetKeyId: string;
  /** 첫 실행이라 질문을 만들지 않고 장부에만 기록한 공지 수 */
  seeded: number;
  /** 커서보다 새로운 공지 수 */
  fresh: number;
  /** 이번 인스턴스가 선점한 공지. 이 목록만 질문 생성으로 넘어간다 */
  claimed: ZiggleNoticeSummary[];
}

/**
 * 지글 공지를 모아 "아직 처리하지 않은 것"만 골라내는 단계.
 *
 * 5단계에서 claimed를 LLM에 넘긴다. 지금은 선점까지만 하고 로그를 남긴다.
 * 수집 로직을 고치는 동안 LLM 비용이 나가지 않게 일부러 나눠 두었다.
 */
@Injectable()
export class NoticeIngestionService {
  private readonly logger = new Logger(NoticeIngestionService.name);
  private readonly widgetKeyIds: string[];
  private readonly maxPerRun: number;
  private readonly enabled: boolean;

  constructor(
    private readonly feed: NoticeFeedService,
    private readonly repo: SuggestedQuestionsRepository,
    configService: ConfigService,
  ) {
    this.enabled =
      configService.get<boolean>('SUGGESTED_QUESTIONS_ENABLED') === true;

    // `*`는 받지 않는다. 모든 위젯에 질문을 뿌리는 건 의도일 수 없다.
    this.widgetKeyIds = (
      configService.get<string>('SUGGESTED_QUESTIONS_WIDGET_KEY_IDS') ?? ''
    )
      .split(',')
      .map((id) => id.trim())
      .filter((id) => id.length > 0 && id !== '*');

    const max = Number(
      configService.get('SUGGESTED_QUESTIONS_MAX_NOTICES_PER_RUN'),
    );
    this.maxPerRun =
      Number.isInteger(max) && max > 0 ? max : DEFAULT_MAX_NOTICES_PER_RUN;
  }

  /** 켜져 있고 대상 위젯 키가 지정됐는지 */
  isEnabled(): boolean {
    return this.enabled && this.widgetKeyIds.length > 0;
  }

  /**
   * 한 주기 분량의 수집.
   * 공지 목록은 한 번만 받아 와서 모든 위젯 키가 나눠 쓴다. 커서와 장부는 위젯 키마다 따로다.
   */
  async run(signal?: AbortSignal): Promise<NoticeIngestionResult[]> {
    const notices = await this.feed.fetchRecent(signal);
    this.logger.log(
      `Ziggle에서 공지 ${notices.length}건 수집 (최신 id=${notices[0]?.id ?? '-'})`,
    );

    const results: NoticeIngestionResult[] = [];
    for (const widgetKeyId of this.widgetKeyIds) {
      signal?.throwIfAborted();

      const widgetKeyName = await this.repo.findWidgetKeyName(widgetKeyId);
      if (!widgetKeyName) {
        this.logger.warn(
          `설정에 있는 위젯 키를 찾을 수 없어 건너뜁니다: ${widgetKeyId}`,
        );
        continue;
      }
      results.push(await this.runForWidgetKey(widgetKeyId, notices));
    }
    return results;
  }

  private async runForWidgetKey(
    widgetKeyId: string,
    notices: ZiggleNoticeSummary[],
  ): Promise<NoticeIngestionResult> {
    const cursor = await this.repo.maxIngestedNoticeId(widgetKeyId);

    // 첫 실행: 지금 보이는 공지는 전부 "이미 지나간 것"으로 접어 둔다.
    // 과거 공지로 질문을 만들 이유가 없고, 안 그러면 첫 주기에 수백 번 LLM을 부른다.
    if (cursor === null) {
      const seeded = await this.repo.seedNotices(
        widgetKeyId,
        notices.map((notice) => notice.id),
      );
      this.logger.log(
        `[${widgetKeyId}] 첫 실행: 공지 ${seeded}건을 기준점으로 기록했습니다. ` +
          `다음 주기부터 id > ${notices[0]?.id ?? 0} 인 공지만 처리합니다.`,
      );
      return { widgetKeyId, seeded, fresh: 0, claimed: [] };
    }

    const fresh = notices.filter((notice) => notice.id > cursor);
    const claimed: ZiggleNoticeSummary[] = [];
    for (const notice of fresh.slice(0, this.maxPerRun)) {
      if (await this.repo.claimNotice(widgetKeyId, notice.id)) {
        claimed.push(notice);
      }
    }

    const skipped = fresh.length - claimed.length;
    this.logger.log(
      `[${widgetKeyId}] 커서 ${cursor} 기준 새 공지 ${fresh.length}건, 선점 ${claimed.length}건` +
        (skipped > 0 ? ` (${skipped}건은 상한 초과이거나 이미 처리됨)` : ''),
    );
    for (const notice of claimed) {
      this.logger.debug(
        `[${widgetKeyId}] 선점 id=${notice.id} 요약=${notice.summary ? '있음' : '없음'} ${notice.title}`,
      );
    }

    return { widgetKeyId, seeded: 0, fresh: fresh.length, claimed };
  }
}
