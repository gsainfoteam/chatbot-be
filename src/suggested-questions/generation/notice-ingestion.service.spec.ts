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
  cursor: number | null;
  claim?: (noticeId: number) => boolean;
  generate?: (noticeId: number) => NoticeGenerationResult;
  generateThrows?: boolean;
  widgetKeyIds?: string;
  maxPerRun?: number;
  widgetKeyExists?: boolean;
}) {
  const feed = {
    fetchRecent: jest.fn(async () => options.notices),
  } as unknown as NoticeFeedService;

  const repo = {
    findWidgetKeyName: jest.fn(async () =>
      options.widgetKeyExists === false ? null : 'GIST 위젯',
    ),
    maxIngestedNoticeId: jest.fn(async () => options.cursor),
    seedNotices: jest.fn(async (_id: string, ids: number[]) => ids.length),
    claimNotice: jest.fn(async (_id: string, noticeId: number) =>
      options.claim ? options.claim(noticeId) : true,
    ),
    releaseNotice: jest.fn(async () => undefined),
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
  describe('first run', () => {
    it('records a baseline without calling the model', async () => {
      const { service, repo, generator } = build({
        notices: [notice(199293), notice(199290), notice(88)],
        cursor: null,
      });

      const [result] = await service.run();

      expect(repo.seedNotices).toHaveBeenCalledWith(KEY, [199293, 199290, 88]);
      expect(repo.claimNotice).not.toHaveBeenCalled();
      expect(generator.generateForNotice).not.toHaveBeenCalled();
      expect(result).toMatchObject({
        seeded: 3,
        fresh: 0,
        claimed: 0,
        saved: 0,
      });
    });
  });

  describe('later runs', () => {
    it('ignores notices at or below the cursor', async () => {
      const { service, repo } = build({
        notices: [notice(199293), notice(199290), notice(88)],
        cursor: 199290,
      });

      const [result] = await service.run();

      expect(result.fresh).toBe(1);
      expect(repo.claimNotice).toHaveBeenCalledTimes(1);
      expect(repo.claimNotice).toHaveBeenCalledWith(KEY, 199293);
    });

    it('only generates for notices it claimed', async () => {
      const { service, generator } = build({
        notices: [notice(199293), notice(199292)],
        cursor: 199000,
        claim: (id) => id === 199293,
      });

      const [result] = await service.run();

      expect(result.claimed).toBe(1);
      expect(generator.generateForNotice).toHaveBeenCalledTimes(1);
      expect(generator.generateForNotice).toHaveBeenCalledWith(
        KEY,
        expect.objectContaining({ id: 199293 }),
        undefined,
      );
    });

    it('caps how many notices one run takes, taking the oldest first', async () => {
      // 피드는 최신순으로 오지만 오래된 것부터 처리해야 한다. 최신부터 처리하면
      // 커서(MAX(notice_id))가 남은 과거 공지를 추월해 영영 집지 못한다.
      const { service, repo } = build({
        notices: [notice(5), notice(4), notice(3), notice(2)],
        cursor: 1,
        maxPerRun: 2,
      });

      const [result] = await service.run();

      expect(repo.claimNotice).toHaveBeenCalledTimes(2);
      expect(jest.mocked(repo.claimNotice).mock.calls.map((c) => c[1])).toEqual(
        [2, 3],
      );
      expect(result).toMatchObject({ claimed: 2, saved: 4, fresh: 4 });
    });

    it('leaves the rest of a backlog for the next pass', async () => {
      // 1회차에 2건만 처리하고, 커서가 그 2건까지만 올라가야 나머지가 살아남는다.
      const notices = [notice(5), notice(4), notice(3), notice(2)];
      const first = build({ notices, cursor: 1, maxPerRun: 2 });
      await first.service.run();
      const firstIds = jest
        .mocked(first.repo.claimNotice)
        .mock.calls.map((c) => c[1]);

      // 다음 주기의 커서는 1회차가 기록한 가장 큰 id다.
      const second = build({
        notices,
        cursor: Math.max(...firstIds),
        maxPerRun: 2,
      });
      await second.service.run();
      const secondIds = jest
        .mocked(second.repo.claimNotice)
        .mock.calls.map((c) => c[1]);

      expect(firstIds).toEqual([2, 3]);
      expect(secondIds).toEqual([4, 5]);
      expect([...firstIds, ...secondIds]).toEqual([2, 3, 4, 5]);
    });

    it('stops the pass at a failure so the cursor cannot pass it', async () => {
      // 실패한 공지 뒤를 계속 처리하면 커서가 그 공지를 넘어가 다시 집지 못한다.
      const { service, repo } = build({
        notices: [notice(5), notice(4), notice(3), notice(2)],
        cursor: 1,
        maxPerRun: 4,
        generate: (id) => {
          if (id === 3) throw new Error('LLM timeout');
          return { noticeId: id, saved: 1, skipped: false };
        },
      });

      const [result] = await service.run();

      expect(jest.mocked(repo.claimNotice).mock.calls.map((c) => c[1])).toEqual(
        [2, 3],
      );
      expect(repo.releaseNotice).toHaveBeenCalledWith(KEY, 3);
      expect(result).toMatchObject({ claimed: 2, saved: 1, failed: 1 });
    });

    it('counts notices whose body could not be read', async () => {
      const { service } = build({
        notices: [notice(5)],
        cursor: 1,
        generate: (id) => ({ noticeId: id, saved: 0, skipped: true }),
      });

      const [result] = await service.run();

      expect(result).toMatchObject({ claimed: 1, saved: 0, skipped: 1 });
    });

    it('keeps the claim when the model simply had nothing to ask', async () => {
      const { service, repo } = build({
        notices: [notice(5)],
        cursor: 1,
        generate: (id) => ({ noticeId: id, saved: 0, skipped: false }),
      });

      const [result] = await service.run();

      expect(repo.releaseNotice).not.toHaveBeenCalled();
      expect(result).toMatchObject({ claimed: 1, saved: 0, failed: 0 });
    });

    it('releases the claim when the model call fails', async () => {
      const { service, repo } = build({
        notices: [notice(5)],
        cursor: 1,
        generateThrows: true,
      });

      const [result] = await service.run();

      expect(repo.releaseNotice).toHaveBeenCalledWith(KEY, 5);
      expect(result).toMatchObject({ claimed: 1, saved: 0, failed: 1 });
    });

    it('skips widget keys that no longer exist', async () => {
      const { service, repo } = build({
        notices: [notice(5)],
        cursor: 1,
        widgetKeyExists: false,
      });

      await expect(service.run()).resolves.toEqual([]);
      expect(repo.claimNotice).not.toHaveBeenCalled();
    });
  });

  describe('isEnabled', () => {
    it('is off when no widget key is configured', () => {
      const { service } = build({
        notices: [],
        cursor: null,
        widgetKeyIds: '',
      });

      expect(service.isEnabled()).toBe(false);
    });

    it('refuses the * wildcard', () => {
      const { service } = build({
        notices: [],
        cursor: null,
        widgetKeyIds: '*',
      });

      expect(service.isEnabled()).toBe(false);
    });

    it('is on for an explicit widget key', () => {
      const { service } = build({ notices: [], cursor: null });

      expect(service.isEnabled()).toBe(true);
    });
  });
});
