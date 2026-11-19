import { Injectable, Logger, type OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { NoticeIngestionService } from './notice-ingestion.service';

/** 기본 수집 주기. 공지는 6시간마다 훑어도 충분하다. */
export const DEFAULT_INTERVAL_MS = 21_600_000;
/** 연속 실패 시 간격을 늘릴 때의 상한 */
export const MAX_BACKOFF_MS = 3_600_000;

/**
 * 추천 질문 생성 주기 작업.
 *
 * EmbeddingBackfillWorker와 같은 방식이다. cron 라이브러리나 쿠버네티스 CronJob이 아니라
 * 앱 프로세스 안에서 도는 타이머다. 레포의 주기 작업이 전부 이 모양이라 맞췄다.
 *
 * - setInterval이 아니라 "끝나면 다음 예약"이라 한 번이 길어져도 겹치지 않는다.
 * - 인스턴스마다 각자 돈다. 같은 공지를 두 번 처리하는 건 장부(notice_question_ingestions)가 막는다.
 */
@Injectable()
export class SuggestedQuestionsWorker implements OnModuleDestroy {
  private readonly logger = new Logger(SuggestedQuestionsWorker.name);
  private readonly abort = new AbortController();
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private started = false;
  private failures = 0;

  constructor(
    private readonly config: ConfigService,
    private readonly ingestion: NoticeIngestionService,
  ) {}

  /** app.listen() 뒤에 직접 부른다. 마이그레이션과 HTTP 기동이 먼저 끝나게 하려는 것. */
  start(): void {
    if (this.started || this.abort.signal.aborted) return;
    this.started = true;

    if (!this.ingestion.isEnabled()) {
      this.logger.log(
        '추천 질문 생성 주기 작업이 꺼져 있습니다 ' +
          '(SUGGESTED_QUESTIONS_ENABLED / SUGGESTED_QUESTIONS_WIDGET_KEY_IDS 확인)',
      );
      return;
    }

    this.logger.log('추천 질문 생성 주기 작업을 시작합니다');
    this.schedule(0);
  }

  private schedule(delay: number): void {
    if (this.abort.signal.aborted) return;
    this.timer = setTimeout(() => {
      this.running = this.tick();
    }, delay);
    // 이 타이머 때문에 프로세스가 살아 있지는 않게 한다.
    this.timer.unref();
  }

  private async tick(): Promise<void> {
    const interval = this.config.get<number>(
      'SUGGESTED_QUESTIONS_INTERVAL_MS',
      DEFAULT_INTERVAL_MS,
    );

    try {
      const results = await this.ingestion.run(this.abort.signal);
      const total = results.reduce(
        (sum, result) => ({
          seeded: sum.seeded + result.seeded,
          claimed: sum.claimed + result.claimed,
          saved: sum.saved + result.saved,
          failed: sum.failed + result.failed,
        }),
        { seeded: 0, claimed: 0, saved: 0, failed: 0 },
      );
      this.logger.log(
        `주기 작업 완료 — 위젯 키 ${results.length}개, 기준점 ${total.seeded}건, ` +
          `공지 ${total.claimed}건, 질문 ${total.saved}건 저장, 실패 ${total.failed}건`,
      );
      this.failures = 0;
    } catch (error) {
      if (this.abort.signal.aborted) return;
      this.failures += 1;
      this.logger.warn(
        `주기 작업 실패, 나중에 다시 시도합니다: ${error instanceof Error ? error.message : String(error)}`,
      );
    }

    // 완료 기준으로 다음을 예약해 겹치지 않게 한다. 지글이나 LLM이 죽었을 때
    // 계속 두드리지 않도록 실패할수록 간격을 늘린다.
    // 기본 주기(6시간)가 이미 상한보다 길어 평소에는 백오프가 작동하지 않는다.
    // 주기를 짧게 바꿔 둔 환경에서만 의미가 있다.
    this.schedule(
      Math.min(
        interval * 2 ** Math.min(this.failures, 10),
        Math.max(interval, MAX_BACKOFF_MS),
      ),
    );
  }

  async onModuleDestroy(): Promise<void> {
    if (this.timer) clearTimeout(this.timer);
    this.abort.abort();
    // 진행 중인 지글·LLM 호출은 signal로 끊기고, 남은 DB 작업만 기다린다.
    await this.running;
  }
}
