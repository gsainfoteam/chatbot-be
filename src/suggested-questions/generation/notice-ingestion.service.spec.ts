import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { ZiggleNoticeSummary } from '../../chat/agent/tools/ziggle/ziggle-notice.client';
import type { SuggestedQuestionsRepository } from '../suggested-questions.repository';
import type {
  NoticeGenerationResult,
  QuestionGenerationService,
} from './question-generation.service';
import type { NoticeFeedService } from './notice-feed.service';
import {
  NoticeIngestionService,
  RECENT_NOTICE_WINDOW,
} from './notice-ingestion.service';

function notice(
  id: number,
  summary: string | null = null,
): ZiggleNoticeSummary {
  return { id, title: `공지 ${id}`, summary };
}

function config(values: Record<string, unknown>) {
  return { get: (key: string) => values[key] } as unknown as ConfigService;
}

function build(options: {
  notices: ZiggleNoticeSummary[];
  /** 이미 장부에 기록돼 있는 공지 id */
  ingested?: number[];
  generate?: (noticeId: number) => NoticeGenerationResult;
  generateThrows?: boolean;
  enabled?: boolean;
}) {
  const feed = {
    fetchRecent: jest.fn(async () => options.notices),
  } as unknown as NoticeFeedService;

  const ingested = options.ingested ?? [];
  const repo = {
    ingestedNoticeIds: jest.fn(
      async (ids: number[]) =>
        new Set(ids.filter((id) => ingested.includes(id))),
    ),
    recordNotice: jest.fn(async () => undefined),
  } as unknown as SuggestedQuestionsRepository;

  const generator = {
    generateForNotice: jest.fn(async (n: ZiggleNoticeSummary) => {
      if (options.generateThrows) throw new Error('LLM timeout');
      return (
        options.generate?.(n.id) ?? {
          noticeId: n.id,
          saved: 2,
          skipped: false,
        }
      );
    }),
  } as unknown as QuestionGenerationService;

  const service = new NoticeIngestionService(
    feed,
    repo,
    generator,
    config({
      SUGGESTED_QUESTIONS_ENABLED: options.enabled ?? true,
    }),
  );
  return { service, repo, generator, feed };
}

describe('NoticeIngestionService', () => {
  describe('장부에 없는 공지만 처리한다', () => {
    it('only generates for notices missing from the ledger', async () => {
      const { service, generator, repo } = build({
        notices: [notice(199293), notice(199290), notice(88)],
        ingested: [199290, 88],
      });

      const result = await service.run();

      expect(result.pending).toBe(1);
      expect(generator.generateForNotice).toHaveBeenCalledTimes(1);
      expect(generator.generateForNotice).toHaveBeenCalledWith(
        expect.objectContaining({ id: 199293 }),
        undefined,
      );
      expect(repo.recordNotice).toHaveBeenCalledWith(199293);
    });

    it('asks the feed for exactly the recent window', async () => {
      // 자르는 일은 피드가 한다. 여기서는 몇 건을 달라고 했는지만 본다.
      const { service, feed } = build({ notices: [notice(5)] });

      await service.run();

      expect(feed.fetchRecent).toHaveBeenCalledWith(
        RECENT_NOTICE_WINDOW,
        undefined,
      );
    });

    it('lets a caller widen the window for a backfill', async () => {
      const { service, feed } = build({ notices: [notice(5)] });

      await service.run(undefined, 300);

      expect(feed.fetchRecent).toHaveBeenCalledWith(300, undefined);
    });

    it('processes every pending notice inside the window in one pass', async () => {
      // 주기당 처리 상한을 따로 두지 않는다. 창 크기가 이미 상한이다.
      const notices = [notice(5), notice(4), notice(3), notice(2)];
      const { service, repo } = build({ notices, ingested: [4, 2] });

      const result = await service.run();

      expect(
        jest.mocked(repo.recordNotice).mock.calls.map((c) => c[0]),
      ).toEqual([5, 3]);
      expect(result).toMatchObject({ pending: 2, processed: 2 });
    });
  });

  describe('장부 기록 시점', () => {
    it('does not record a notice whose generation threw', async () => {
      // 기록이 생성 뒤에 오므로, 예외로 끊긴 공지는 장부에 남지 않고 다음 주기에 다시 집힌다.
      const { service, repo } = build({
        notices: [notice(5)],
        generateThrows: true,
      });

      const result = await service.run();

      expect(repo.recordNotice).not.toHaveBeenCalled();
      expect(result).toMatchObject({ processed: 0, saved: 0, failed: 1 });
    });

    it('keeps processing the rest after one notice fails', async () => {
      // 커서가 없으니 실패한 공지 뒤를 멈출 이유가 없다.
      const { service, repo } = build({
        notices: [notice(5), notice(4), notice(3)],
        generate: (id) => {
          if (id === 4) throw new Error('LLM timeout');
          return { noticeId: id, saved: 1, skipped: false };
        },
      });

      const result = await service.run();

      expect(
        jest.mocked(repo.recordNotice).mock.calls.map((c) => c[0]),
      ).toEqual([5, 3]);
      expect(result).toMatchObject({ processed: 2, saved: 2, failed: 1 });
    });

    it('records notices whose body could not be read', async () => {
      // 본문이 이미지뿐인 공지는 다시 읽어도 결과가 같다. 매 주기 재시도할 이유가 없다.
      const { service, repo } = build({
        notices: [notice(5)],
        generate: (id) => ({ noticeId: id, saved: 0, skipped: true }),
      });

      const result = await service.run();

      expect(repo.recordNotice).toHaveBeenCalledWith(5);
      expect(result).toMatchObject({ processed: 1, saved: 0, skipped: 1 });
    });

    it('records notices the model had nothing to ask about', async () => {
      const { service, repo } = build({
        notices: [notice(5)],
        generate: (id) => ({ noticeId: id, saved: 0, skipped: false }),
      });

      const result = await service.run();

      expect(repo.recordNotice).toHaveBeenCalledWith(5);
      expect(result).toMatchObject({ processed: 1, saved: 0, failed: 0 });
    });
  });

  describe('isEnabled', () => {
    it('follows SUGGESTED_QUESTIONS_ENABLED', () => {
      expect(build({ notices: [] }).service.isEnabled()).toBe(true);
      expect(build({ notices: [], enabled: false }).service.isEnabled()).toBe(
        false,
      );
    });
  });
});
