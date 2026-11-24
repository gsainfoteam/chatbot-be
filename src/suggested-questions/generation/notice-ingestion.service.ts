import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { ZiggleNoticeSummary } from '../../chat/agent/tools/ziggle/ziggle-notice.client';
import { SuggestedQuestionsRepository } from '../suggested-questions.repository';
import { NoticeFeedService } from './notice-feed.service';
import { QuestionGenerationService } from './question-generation.service';

/**
 * 정기 작업이 한 번에 볼 최신 공지 건수.
 *
 * 이 중 장부에 이미 있는 공지는 LLM도 본문 조회도 타지 않고 장부 조회 한 번으로
 * 걸러진다. 그래서 새 공지가 없는 주기는 수집만 하고 끝난다.
 *
 * 밀린 공지를 이 작업이 기어서 처리하지 않는다. 기존 공지는 백필 스크립트
 * (`src/scripts/backfill-suggested-questions.ts`)가 한 번에 돌린다. 그래서 이 값은
 * "한 주기(6시간) 사이에 올라올 수 있는 공지 수"만 덮으면 된다.
 *
 * 지글 공지는 하루 몇 건 수준이라 10건이면 며칠분이다. 생성이 며칠 멈춰도
 * 그 사이 공지가 창 밖으로 밀려나지 않는다.
 */
export const RECENT_NOTICE_WINDOW = 10;

export interface NoticeIngestionResult {
  widgetKeyId: string;
  /** 수집된 공지 중 장부에 없던 수 */
  pending: number;
  /** 처리를 끝내고 장부에 기록한 공지 수 */
  processed: number;
  /** 저장된 질문 수(PENDING) */
  saved: number;
  /** 본문을 읽지 못해 질문을 만들지 못한 공지 수 */
  skipped: number;
  /** 예외로 끊겨 장부에 기록하지 않은 공지 수. 다음 주기에 다시 시도한다 */
  failed: number;
}

/**
 * 지글 공지를 모아 장부에 없는 것만 골라 질문 생성으로 넘긴다.
 *
 * 장부 기록은 생성이 끝난 뒤에 한다. 그래서 예외로 끊긴 공지는 기록되지 않고
 * 다음 주기에 다시 집힌다. 질문을 못 만든 공지(본문이 이미지뿐, 물어볼 게 없음)는
 * 확정된 결론이므로 기록해 두고 다시 읽지 않는다.
 */
@Injectable()
export class NoticeIngestionService {
  private readonly logger = new Logger(NoticeIngestionService.name);
  private readonly widgetKeyIds: string[];
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
  }

  /** 켜져 있고 대상 위젯 키가 지정됐는지 */
  isEnabled(): boolean {
    return this.enabled && this.widgetKeyIds.length > 0;
  }

  /**
   * 한 주기 분량의 수집.
   * 공지 목록은 한 번만 받아 와서 모든 위젯 키가 나눠 쓴다. 장부는 위젯 키마다 따로다.
   */
  async run(
    signal?: AbortSignal,
    limit: number = RECENT_NOTICE_WINDOW,
  ): Promise<NoticeIngestionResult[]> {
    const notices = await this.feed.fetchRecent(limit, signal);
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
    // 피드가 이미 최신순으로 limit건만 주므로 여기서 더 자르지 않는다.
    const ingested = await this.repo.ingestedNoticeIds(
      widgetKeyId,
      notices.map((notice) => notice.id),
    );
    const pending = notices.filter((notice) => !ingested.has(notice.id));

    let processed = 0;
    let saved = 0;
    let skipped = 0;
    let failed = 0;

    for (const notice of pending) {
      signal?.throwIfAborted();

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
        // 네트워크·타임아웃 같은 일시적 실패. 장부에 기록하지 않아 다음 주기에
        // 다시 집힌다. 뒤 공지는 계속 처리한다.
        failed += 1;
        this.logger.warn(
          `[${widgetKeyId}] id=${notice.id} 질문 생성 실패, 다음 주기에 재시도: ` +
            (error instanceof Error ? error.message : String(error)),
        );
        continue;
      }

      await this.repo.recordNotice(widgetKeyId, notice.id);
      processed += 1;
    }

    this.logger.log(
      `[${widgetKeyId}] 장부에 없는 공지 ${pending.length}건 → ` +
        `처리 ${processed}건, 질문 ${saved}건 저장` +
        (skipped > 0 ? `, 본문 없음 ${skipped}건` : '') +
        (failed > 0 ? `, 실패 ${failed}건` : ''),
    );

    return {
      widgetKeyId,
      pending: pending.length,
      processed,
      saved,
      skipped,
      failed,
    };
  }
}
