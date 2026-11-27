import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { NoticeIngestionService } from './notice-ingestion.service';

/**
 * 실행 시각. 하루 네 번, 6시간 간격이다.
 *
 * 주기를 짧게 둬도 LLM 호출 수는 늘지 않는다. 장부(notice_question_ingestions)가
 * 공지당 1회 처리를 보장하므로, 새 공지가 없는 실행은 지글 검색 몇 번으로 끝난다.
 * 그래서 비용이 아니라 **신선도**로 정한 값이다. 6시간이면 공지가 올라와서
 * 질문이 만들어지기까지 평균 3시간이 걸린다.
 */
export const SUGGESTED_QUESTIONS_CRON = '0 0,6,12,18 * * *';

/** 컨테이너가 UTC로 돌기 때문에 타임존을 명시해야 한국 시간 기준으로 돈다. */
export const SUGGESTED_QUESTIONS_TIME_ZONE = 'Asia/Seoul';

/**
 * 추천 질문 생성 주기 작업.
 *
 * 예약은 @nestjs/schedule에 맡긴다. 직접 setTimeout을 돌리면 실행 시각이 앱이 뜬
 * 시점에 묶여 재배포마다 밀린다. cron 표현식은 절대 시각이라 그 문제가 없다.
 *
 * 기존 공지를 한 번에 채우는 일은 이 작업이 하지 않는다. 최신 창만 본다.
 */
@Injectable()
export class SuggestedQuestionsWorker implements OnModuleDestroy {
  private readonly logger = new Logger(SuggestedQuestionsWorker.name);
  private readonly abort = new AbortController();
  private running: Promise<void> | undefined;

  constructor(private readonly ingestion: NoticeIngestionService) {}

  @Cron(SUGGESTED_QUESTIONS_CRON, { timeZone: SUGGESTED_QUESTIONS_TIME_ZONE })
  async handleCron(): Promise<void> {
    // 데코레이터는 설정과 무관하게 등록되므로 꺼져 있는지 여기서 본다.
    if (!this.ingestion.isEnabled() || this.abort.signal.aborted) return;

    // 한 번이 6시간을 넘길 일은 없지만, 넘기면 겹치지 않게 건너뛴다.
    if (this.running) {
      this.logger.warn('이전 실행이 아직 끝나지 않아 이번 주기는 건너뜁니다');
      return;
    }

    this.running = this.run();
    try {
      await this.running;
    } finally {
      this.running = undefined;
    }
  }

  private async run(): Promise<void> {
    try {
      const result = await this.ingestion.run(this.abort.signal);
      this.logger.log(
        `주기 작업 완료 — 공지 ${result.processed}건 처리, ` +
          `질문 ${result.saved}건 저장, 실패 ${result.failed}건`,
      );
    } catch (error) {
      if (this.abort.signal.aborted) return;
      // 다음 주기에 다시 돈다. 장부에 기록되지 않은 공지는 그대로 남아 있다.
      this.logger.warn(
        `주기 작업 실패, 다음 주기에 다시 시도합니다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.abort.abort();
    // 진행 중인 지글·LLM 호출은 signal로 끊기고, 남은 DB 작업만 기다린다.
    await this.running;
  }
}
