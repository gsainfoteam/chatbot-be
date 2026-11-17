import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ZiggleNoticeSummary } from '../../chat/agent/tools/ziggle/ziggle-notice.client';
import { SuggestedQuestionsRepository } from '../suggested-questions.repository';
import { NoticeFeedService } from './notice-feed.service';
import { QuestionGenerationService } from './question-generation.service';

export const DEFAULT_MAX_NOTICES_PER_RUN = 10;

export interface NoticeIngestionResult {
  widgetKeyId: string;
  /** 첫 실행이라 질문을 만들지 않고 장부에만 기록한 공지 수 */
  seeded: number;
  /** 커서보다 새로운 공지 수 */
  fresh: number;
  /** 이번 인스턴스가 선점한 공지 수 */
  claimed: number;
  /** 저장된 질문 수(PENDING) */
  saved: number;
  /** 본문을 읽지 못해 건너뛴 공지 수 */
  skipped: number;
  /** LLM 호출이 실패해 선점을 되돌린 공지 수 */
  failed: number;
}

/**
 * 지글 공지를 모아 아직 처리하지 않은 것만 골라 질문 생성으로 넘긴다.
 *
 * 선점에 성공한 공지만 LLM에 들어간다. 호출이 실패하면 선점을 되돌려
 * 다음 주기에 다시 시도하게 한다.
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
    private readonly generator: QuestionGenerationService,
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
      results.push(await this.runForWidgetKey(widgetKeyId, notices, signal));
    }
    return results;
  }

  private async runForWidgetKey(
    widgetKeyId: string,
    notices: ZiggleNoticeSummary[],
    signal?: AbortSignal,
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
      return {
        widgetKeyId,
        seeded,
        fresh: 0,
        claimed: 0,
        saved: 0,
        skipped: 0,
        failed: 0,
      };
    }

    const fresh = notices.filter((notice) => notice.id > cursor);
    let claimed = 0;
    let saved = 0;
    let skipped = 0;
    let failed = 0;

    for (const notice of fresh.slice(0, this.maxPerRun)) {
      signal?.throwIfAborted();
      if (!(await this.repo.claimNotice(widgetKeyId, notice.id))) continue;
      claimed += 1;

      try {
        const result = await this.generator.generateForNotice(
          widgetKeyId,
          notice,
          signal,
        );
        saved += result.saved;
        if (result.skipped) skipped += 1;
      } catch (error) {
        if (signal?.aborted) throw error;
        // 네트워크·타임아웃 같은 일시적 실패. 선점을 되돌려 다음 주기에 다시 집게 한다.
        // 되돌리지 않으면 이 공지는 질문 없이 영영 처리됨으로 남는다.
        failed += 1;
        await this.repo.releaseNotice(widgetKeyId, notice.id);
        this.logger.warn(
          `[${widgetKeyId}] id=${notice.id} 질문 생성 실패, 선점 취소: ` +
            (error instanceof Error ? error.message : String(error)),
        );
      }
    }

    this.logger.log(
      `[${widgetKeyId}] 커서 ${cursor} 기준 새 공지 ${fresh.length}건 → ` +
        `선점 ${claimed}건, 질문 ${saved}건 저장` +
        (skipped > 0 ? `, 본문 없음 ${skipped}건` : '') +
        (failed > 0 ? `, 실패 ${failed}건` : ''),
    );

    return {
      widgetKeyId,
      seeded: 0,
      fresh: fresh.length,
      claimed,
      saved,
      skipped,
      failed,
    };
  }
}
