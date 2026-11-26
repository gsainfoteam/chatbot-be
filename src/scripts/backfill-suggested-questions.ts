/**
 * 기존 공지에 대해 추천 질문을 한 번에 만드는 수동 진입점.
 *
 * 정기 작업(@Cron)은 최신 10건만 본다. 기능을 처음 켤 때는 이미 올라와 있는
 * 공지들에 질문이 하나도 없으므로, 이 스크립트로 한 번 채운다.
 *
 *   node dist/backfill-suggested-questions.js --count 200
 *
 * 정기 작업과 같은 수집·생성 경로를 쓰고 가져올 건수만 다르다. 장부
 * (notice_question_ingestions)가 공지당 1회를 보장하므로, 이 스크립트를 여러 번
 * 돌리거나 직후에 정기 작업이 돌아도 같은 공지에 다시 질문을 만들지 않는다.
 *
 * 만들어진 질문은 전부 PENDING이다. 관리자가 승인해야 위젯에 나간다.
 * 마감이 지난 공지는 프롬프트에 오늘 날짜를 넘겨 모델이 거르게 하지만,
 * 완벽하지 않으므로 검수 단계에서 한 번 더 걸러야 한다.
 */
import 'reflect-metadata';
import { HttpService } from '@nestjs/axios';
import { ConfigService } from '@nestjs/config';
import { createDatabaseConnection } from '../db';
import { ZiggleNoticeClient } from '../chat/agent/tools/ziggle/ziggle-notice.client';
import { resolveLlmProviderName } from '../chat/llm/llm-client.provider';
import { LetsurLlmService } from '../chat/llm/letsur-llm.service';
import { OpenRouterLlmService } from '../chat/llm/open-router-llm.service';
import { SuggestedQuestionsRepository } from '../suggested-questions/suggested-questions.repository';
import { NoticeFeedService } from '../suggested-questions/generation/notice-feed.service';
import { QuestionGenerationService } from '../suggested-questions/generation/question-generation.service';
import { NoticeIngestionService } from '../suggested-questions/generation/notice-ingestion.service';

/** 아무것도 주지 않았을 때 가져올 공지 수. 지글 공지 속도로 두 달 남짓이다. */
const DEFAULT_COUNT = 200;
const MAX_COUNT = 1000;

function parseCount(argv: string[]): number {
  const index = argv.indexOf('--count');
  if (index < 0) return DEFAULT_COUNT;

  const value = Number(argv[index + 1]);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('--count 는 1 이상의 정수여야 합니다');
  }
  if (value > MAX_COUNT) {
    throw new Error(`--count 는 ${MAX_COUNT} 이하여야 합니다`);
  }
  return value;
}

async function main(): Promise<void> {
  const count = parseCount(process.argv);
  const abort = new AbortController();
  const stop = () => abort.abort();
  process.once('SIGTERM', stop);
  process.once('SIGINT', stop);

  const config = new ConfigService(process.env);

  const db = createDatabaseConnection({
    host: config.getOrThrow<string>('DB_HOST'),
    port: Number(config.getOrThrow('DB_PORT')),
    user: config.getOrThrow<string>('DB_USER'),
    password: config.getOrThrow<string>('DB_PASSWORD'),
    database: config.getOrThrow<string>('DB_NAME'),
    sslEnabled: config.get<string>('DB_SSL', 'false') === 'true',
  });

  try {
    const http = new HttpService();
    const llm =
      resolveLlmProviderName(config.get<string>('LLM_PROVIDER')) ===
      'openrouter'
        ? new OpenRouterLlmService(http, config)
        : new LetsurLlmService(http, config);

    const repo = new SuggestedQuestionsRepository(db);
    const ziggle = new ZiggleNoticeClient(config);
    const ingestion = new NoticeIngestionService(
      new NoticeFeedService(ziggle),
      repo,
      new QuestionGenerationService(llm, ziggle, repo),
      config,
    );

    console.log(`공지 ${count}건을 대상으로 백필을 시작합니다`);
    const result = await ingestion.run(abort.signal, count);

    console.log(
      `장부에 없던 공지 ${result.pending}건 → ` +
        `처리 ${result.processed}건, 질문 ${result.saved}건 저장(PENDING)` +
        (result.skipped > 0 ? `, 본문 없음 ${result.skipped}건` : '') +
        (result.failed > 0 ? `, 실패 ${result.failed}건` : ''),
    );
    if (result.failed > 0) {
      console.warn(
        `${result.failed}건은 생성에 실패해 장부에 기록하지 않았습니다. 다시 돌리면 재시도합니다`,
      );
    }
    console.log('백필 완료');
  } finally {
    process.removeListener('SIGTERM', stop);
    process.removeListener('SIGINT', stop);
    await db.$client.end({ timeout: 5 });
  }
}

main().catch((error: unknown) => {
  console.error(
    '백필 실패:',
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});
