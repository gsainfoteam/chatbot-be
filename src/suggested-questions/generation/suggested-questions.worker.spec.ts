import { describe, expect, it, jest } from '@jest/globals';
import { CronTime } from 'cron';
import type { NoticeIngestionService } from './notice-ingestion.service';
import {
  SUGGESTED_QUESTIONS_CRON,
  SUGGESTED_QUESTIONS_TIME_ZONE,
  SuggestedQuestionsWorker,
} from './suggested-questions.worker';

function fixture({ enabled = true }: { enabled?: boolean } = {}) {
  const run = jest.fn(async (_signal?: AbortSignal) => ({
    pending: 1,
    processed: 1,
    saved: 2,
    skipped: 0,
    failed: 0,
  }));
  const ingestion = {
    isEnabled: jest.fn(() => enabled),
    run,
  } as unknown as NoticeIngestionService;

  return { worker: new SuggestedQuestionsWorker(ingestion), ingestion, run };
}

describe('주기 설정', () => {
  it('fires at 00, 06, 12 and 18 Seoul time', () => {
    // 컨테이너가 UTC라서 타임존을 빼면 9시간 밀린다. 그게 안 밀리는지 본다.
    const cron = new CronTime(
      SUGGESTED_QUESTIONS_CRON,
      SUGGESTED_QUESTIONS_TIME_ZONE,
    );

    let at = new Date('2026-11-24T00:00:00Z'); // 서울 기준 09:00
    const hours: number[] = [];
    for (let i = 0; i < 4; i += 1) {
      const next = cron.getNextDateFrom(at);
      hours.push(next.setZone(SUGGESTED_QUESTIONS_TIME_ZONE).hour);
      at = next.toJSDate();
    }

    expect(hours).toEqual([12, 18, 0, 6]);
  });
});

describe('SuggestedQuestionsWorker', () => {
  it('collects when the cron fires', async () => {
    const f = fixture();

    await f.worker.handleCron();

    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it('stays off when collection is disabled', async () => {
    const f = fixture({ enabled: false });

    await f.worker.handleCron();

    expect(f.run).not.toHaveBeenCalled();
  });

  it('skips a pass while the previous one is still running', async () => {
    const f = fixture();
    let release!: () => void;
    jest.mocked(f.ingestion.run).mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          release = () =>
            resolve({
              pending: 0,
              processed: 0,
              saved: 0,
              skipped: 0,
              failed: 0,
            });
        }),
    );

    const first = f.worker.handleCron();
    await f.worker.handleCron(); // 앞 작업이 끝나기 전에 또 걸린 경우
    expect(f.run).toHaveBeenCalledTimes(1);

    release();
    await first;

    // 앞 작업이 끝났으면 다음 주기는 정상으로 돈다.
    await f.worker.handleCron();
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it('swallows a failure so the schedule survives', async () => {
    const f = fixture();
    jest.mocked(f.ingestion.run).mockRejectedValueOnce(new Error('지글 장애'));

    await expect(f.worker.handleCron()).resolves.toBeUndefined();

    await f.worker.handleCron();
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it('passes an abort signal that shutdown trips', async () => {
    const f = fixture();

    await f.worker.handleCron();
    const signal = jest.mocked(f.ingestion.run).mock.calls[0][0] as AbortSignal;
    expect(signal.aborted).toBe(false);

    await f.worker.onModuleDestroy();

    expect(signal.aborted).toBe(true);
  });

  it('does not collect after shutdown', async () => {
    const f = fixture();

    await f.worker.onModuleDestroy();
    await f.worker.handleCron();

    expect(f.run).not.toHaveBeenCalled();
  });
});
