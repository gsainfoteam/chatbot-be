import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { ZiggleNoticeSummary } from '../../chat/agent/tools/ziggle/ziggle-notice.client';
import type { SuggestedQuestionsRepository } from '../suggested-questions.repository';
import type {
  NoticeGenerationResult,
  QuestionGenerationService,
} from './question-generation.service';
import type { NoticeFeedService } from './notice-feed.service';
import { dedupeByIdDesc } from './notice-feed.service';
import { NoticeIngestionService } from './notice-ingestion.service';

const KEY = '00000000-0000-0000-0000-0000000000b1';

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
  widgetKeyIds?: string;
  maxPerRun?: number;
  widgetKeyExists?: boolean;
}) {
  const feed = {
    fetchRecent: jest.fn(async () => options.notices),
  } as unknown as NoticeFeedService;

  const ingested = options.ingested ?? [];
  const repo = {
    findWidgetKeyName: jest.fn(async () =>
      options.widgetKeyExists === false ? null : 'GIST 위젯',
    ),
    ingestedNoticeIds: jest.fn(
      async (_id: string, ids: number[]) =>
        new Set(ids.filter((id) => ingested.includes(id))),
    ),
    recordNotice: jest.fn(async () => undefined),
  } as unknown as SuggestedQuestionsRepository;

  const generator = {
    generateForNotice: jest.fn(async (_key: string, n: ZiggleNoticeSummary) => {
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
      SUGGESTED_QUESTIONS_ENABLED: true,
      SUGGESTED_QUESTIONS_WIDGET_KEY_IDS: options.widgetKeyIds ?? KEY,
      SUGGESTED_QUESTIONS_MAX_NOTICES_PER_RUN: options.maxPerRun,
    }),
  );
  return { service, repo, generator };
}

describe('dedupeByIdDesc', () => {
  it('keeps one row per notice and puts the newest first', () => {
    const merged = dedupeByIdDesc([
      [notice(100), notice(88)],
      [notice(199293), notice(100)],
    ]);

    expect(merged.map((n) => n.id)).toEqual([199293, 100, 88]);
  });

  it('returns an empty list when every keyword came back empty', () => {
    expect(dedupeByIdDesc([[], []])).toEqual([]);
  });
});

describe('NoticeIngestionService', () => {
  describe('장부에 없는 공지만 처리한다', () => {
    it('only generates for notices missing from the ledger', async () => {
      const { service, generator, repo } = build({
        notices: [notice(199293), notice(199290), notice(88)],
        ingested: [199290, 88],
      });

      const [result] = await service.run();

      expect(result.pending).toBe(1);
      expect(generator.generateForNotice).toHaveBeenCalledTimes(1);
      expect(generator.generateForNotice).toHaveBeenCalledWith(
        KEY,
        expect.objectContaining({ id: 199293 }),
        undefined,
      );
      expect(repo.recordNotice).toHaveBeenCalledWith(KEY, 199293);
    });

    it('caps how many notices one run takes, newest first', async () => {
      const { service, repo } = build({
        notices: [notice(5), notice(4), notice(3), notice(2)],
        maxPerRun: 2,
      });

      const [result] = await service.run();

      expect(
        jest.mocked(repo.recordNotice).mock.calls.map((c) => c[1]),
      ).toEqual([5, 4]);
      expect(result).toMatchObject({ pending: 4, processed: 2, saved: 4 });
    });

    it('leaves the rest of a backlog for the next pass', async () => {
      // 상한에 걸려 남은 공지는 장부에 들어가지 않았으므로 다음 주기에 그대로 집힌다.
      const notices = [notice(5), notice(4), notice(3), notice(2)];
      const first = build({ notices, maxPerRun: 2 });
      await first.service.run();
      const firstIds = jest
        .mocked(first.repo.recordNotice)
        .mock.calls.map((c) => c[1]);

      const second = build({ notices, ingested: firstIds, maxPerRun: 2 });
      await second.service.run();
      const secondIds = jest
        .mocked(second.repo.recordNotice)
        .mock.calls.map((c) => c[1]);

      expect(firstIds).toEqual([5, 4]);
      expect(secondIds).toEqual([3, 2]);
      expect([...firstIds, ...secondIds]).toEqual([5, 4, 3, 2]);
    });

    it('skips widget keys that no longer exist', async () => {
      const { service, repo, generator } = build({
        notices: [notice(5)],
        widgetKeyExists: false,
      });

      await expect(service.run()).resolves.toEqual([]);
      expect(generator.generateForNotice).not.toHaveBeenCalled();
      expect(repo.recordNotice).not.toHaveBeenCalled();
    });
  });

  describe('장부 기록 시점', () => {
    it('does not record a notice whose generation threw', async () => {
      // 기록이 생성 뒤에 오므로, 예외로 끊긴 공지는 장부에 남지 않고 다음 주기에 다시 집힌다.
      const { service, repo } = build({
        notices: [notice(5)],
        generateThrows: true,
      });

      const [result] = await service.run();

      expect(repo.recordNotice).not.toHaveBeenCalled();
      expect(result).toMatchObject({ processed: 0, saved: 0, failed: 1 });
    });

    it('keeps processing the rest after one notice fails', async () => {
      // 커서가 없으니 실패한 공지 뒤를 멈출 이유가 없다.
      const { service, repo } = build({
        notices: [notice(5), notice(4), notice(3)],
        maxPerRun: 3,
        generate: (id) => {
          if (id === 4) throw new Error('LLM timeout');
          return { noticeId: id, saved: 1, skipped: false };
        },
      });

      const [result] = await service.run();

      expect(
        jest.mocked(repo.recordNotice).mock.calls.map((c) => c[1]),
      ).toEqual([5, 3]);
      expect(result).toMatchObject({ processed: 2, saved: 2, failed: 1 });
    });

    it('records notices whose body could not be read', async () => {
      // 본문이 이미지뿐인 공지는 다시 읽어도 결과가 같다. 매 주기 재시도할 이유가 없다.
      const { service, repo } = build({
        notices: [notice(5)],
        generate: (id) => ({ noticeId: id, saved: 0, skipped: true }),
      });

      const [result] = await service.run();

      expect(repo.recordNotice).toHaveBeenCalledWith(KEY, 5);
      expect(result).toMatchObject({ processed: 1, saved: 0, skipped: 1 });
    });

    it('records notices the model had nothing to ask about', async () => {
      const { service, repo } = build({
        notices: [notice(5)],
        generate: (id) => ({ noticeId: id, saved: 0, skipped: false }),
      });

      const [result] = await service.run();

      expect(repo.recordNotice).toHaveBeenCalledWith(KEY, 5);
      expect(result).toMatchObject({ processed: 1, saved: 0, failed: 0 });
    });
  });

  describe('isEnabled', () => {
    it('is off when no widget key is configured', () => {
      const { service } = build({
        notices: [],
        widgetKeyIds: '',
      });

      expect(service.isEnabled()).toBe(false);
    });

    it('refuses the * wildcard', () => {
      const { service } = build({
        notices: [],
        widgetKeyIds: '*',
      });

      expect(service.isEnabled()).toBe(false);
    });

    it('is on for an explicit widget key', () => {
      const { service } = build({ notices: [] });

      expect(service.isEnabled()).toBe(true);
    });
  });
});
