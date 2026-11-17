import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { ZiggleNoticeSummary } from '../../chat/agent/tools/ziggle/ziggle-notice.client';
import type { SuggestedQuestionsRepository } from '../suggested-questions.repository';
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
  } as unknown as SuggestedQuestionsRepository;

  const service = new NoticeIngestionService(
    feed,
    repo,
    config({
      SUGGESTED_QUESTIONS_ENABLED: true,
      SUGGESTED_QUESTIONS_WIDGET_KEY_IDS: options.widgetKeyIds ?? KEY,
      SUGGESTED_QUESTIONS_MAX_NOTICES_PER_RUN: options.maxPerRun,
    }),
  );
  return { service, repo };
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
    it('records the current notices as a baseline without claiming any', async () => {
      const { service, repo } = build({
        notices: [notice(199293), notice(199290), notice(88)],
        cursor: null,
      });

      const [result] = await service.run();

      expect(repo.seedNotices).toHaveBeenCalledWith(KEY, [199293, 199290, 88]);
      expect(repo.claimNotice).not.toHaveBeenCalled();
      expect(result).toMatchObject({ seeded: 3, fresh: 0, claimed: [] });
    });
  });

  describe('later runs', () => {
    it('ignores notices at or below the cursor', async () => {
      // 지글 검색은 최신순이 아니라 아주 오래된 공지(88)도 같이 돌려준다.
      const { service, repo } = build({
        notices: [notice(199293), notice(199290), notice(88)],
        cursor: 199290,
      });

      const [result] = await service.run();

      expect(result.fresh).toBe(1);
      expect(repo.claimNotice).toHaveBeenCalledTimes(1);
      expect(repo.claimNotice).toHaveBeenCalledWith(KEY, 199293);
    });

    it('drops notices another instance already claimed', async () => {
      const { service } = build({
        notices: [notice(199293), notice(199292)],
        cursor: 199000,
        claim: (id) => id === 199293,
      });

      const [result] = await service.run();

      expect(result.claimed.map((n) => n.id)).toEqual([199293]);
      expect(result.fresh).toBe(2);
    });

    it('caps how many notices one run takes', async () => {
      const { service, repo } = build({
        notices: [notice(5), notice(4), notice(3), notice(2)],
        cursor: 1,
        maxPerRun: 2,
      });

      const [result] = await service.run();

      expect(repo.claimNotice).toHaveBeenCalledTimes(2);
      expect(result.claimed.map((n) => n.id)).toEqual([5, 4]);
      expect(result.fresh).toBe(4);
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
