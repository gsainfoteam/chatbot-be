import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  jest,
} from '@jest/globals';
import { ConfigService } from '@nestjs/config';
import type { NoticeIngestionService } from './notice-ingestion.service';
import { SuggestedQuestionsWorker } from './suggested-questions.worker';

const INTERVAL = 1000;

function fixture(
  settings: Record<string, unknown> = {},
  { enabled = true }: { enabled?: boolean } = {},
) {
  const run = jest.fn(async () => [
    {
      widgetKeyId: 'w1',
      pending: 1,
      processed: 1,
      saved: 2,
      skipped: 0,
      failed: 0,
    },
  ]);
  const ingestion = {
    isEnabled: jest.fn(() => enabled),
    run,
  } as unknown as NoticeIngestionService;

  const worker = new SuggestedQuestionsWorker(
    new ConfigService({
      SUGGESTED_QUESTIONS_INTERVAL_MS: INTERVAL,
      ...settings,
    }),
    ingestion,
  );
  return { worker, ingestion, run };
}

describe('SuggestedQuestionsWorker', () => {
  beforeEach(() => {
    jest.useFakeTimers();
  });
  afterEach(() => {
    jest.useRealTimers();
  });

  it('does nothing until it is explicitly started', async () => {
    const f = fixture();

    await jest.advanceTimersByTimeAsync(INTERVAL * 5);

    expect(f.run).not.toHaveBeenCalled();
  });

  it('runs once as soon as it starts', async () => {
    const f = fixture();

    f.worker.start();
    await jest.advanceTimersByTimeAsync(0);

    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it('stays off when collection is disabled', async () => {
    const f = fixture({}, { enabled: false });

    f.worker.start();
    await jest.advanceTimersByTimeAsync(INTERVAL * 5);

    expect(f.run).not.toHaveBeenCalled();
  });

  it('ignores a second start', async () => {
    const f = fixture();

    f.worker.start();
    f.worker.start();
    await jest.advanceTimersByTimeAsync(0);

    expect(f.run).toHaveBeenCalledTimes(1);
  });

  it('schedules the next pass only after the current one finishes', async () => {
    const f = fixture();

    f.worker.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(f.run).toHaveBeenCalledTimes(1);

    // 주기가 지나야 다음이 돈다. 앞 작업이 끝나기 전에는 겹치지 않는다.
    await jest.advanceTimersByTimeAsync(INTERVAL - 1);
    expect(f.run).toHaveBeenCalledTimes(1);

    await jest.advanceTimersByTimeAsync(1);
    expect(f.run).toHaveBeenCalledTimes(2);
  });

  it('keeps going after a failed pass', async () => {
    const f = fixture();
    jest.mocked(f.ingestion.run).mockRejectedValueOnce(new Error('지글 장애'));

    f.worker.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(f.run).toHaveBeenCalledTimes(1);

    // 실패해도 다음이 예약된다. 기본 주기가 백오프 상한보다 길면 간격은 그대로다.
    await jest.advanceTimersByTimeAsync(INTERVAL * 2);
    expect(f.run.mock.calls.length).toBeGreaterThan(1);
  });

  it('stops scheduling once the module is torn down', async () => {
    const f = fixture();

    f.worker.start();
    await jest.advanceTimersByTimeAsync(0);
    const callsBeforeShutdown = f.run.mock.calls.length;

    await f.worker.onModuleDestroy();
    await jest.advanceTimersByTimeAsync(INTERVAL * 5);

    expect(f.run).toHaveBeenCalledTimes(callsBeforeShutdown);
  });

  it('passes an abort signal that shutdown trips', async () => {
    const f = fixture();

    f.worker.start();
    await jest.advanceTimersByTimeAsync(0);

    const signal = jest.mocked(f.ingestion.run).mock.calls[0][0] as AbortSignal;
    expect(signal.aborted).toBe(false);

    await f.worker.onModuleDestroy();

    expect(signal.aborted).toBe(true);
  });
});
