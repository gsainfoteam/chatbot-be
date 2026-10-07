import { ConfigService } from '@nestjs/config';
import { EmbeddingBackfillService } from './embedding-backfill.service';
import { EmbeddingBackfillWorker } from './embedding-backfill.worker';

function fixture(settings: Record<string, unknown> = {}) {
  const service = {
    isEnabled: jest.fn(() => true),
    run: jest.fn(async (_signal: AbortSignal) => ({
      selected: 0,
      saved: 0,
      failed: 0,
    })),
  };
  const worker = new EmbeddingBackfillWorker(
    new ConfigService({ EMBEDDING_BACKFILL_INTERVAL_MS: 1000, ...settings }),
    service as unknown as EmbeddingBackfillService,
  );
  return { worker, service };
}

describe('embedding backfill worker', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('does no work until explicitly started and never waits for backfill to start HTTP', async () => {
    const f = fixture();
    await jest.advanceTimersByTimeAsync(10000);
    expect(f.service.run).not.toHaveBeenCalled();
    expect(f.worker.start()).toBeUndefined();
    f.worker.start();
    await jest.advanceTimersByTimeAsync(0);
    expect(f.service.run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.service.run).toHaveBeenCalledTimes(2);
    await f.worker.onModuleDestroy();
  });

  it('does not overlap slow passes', async () => {
    const f = fixture();
    let finish!: (value: {
      selected: number;
      saved: number;
      failed: number;
    }) => void;
    f.service.run.mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
    f.worker.start();
    await jest.advanceTimersByTimeAsync(5000);
    expect(f.service.run).toHaveBeenCalledTimes(1);
    finish({ selected: 1, saved: 1, failed: 0 });
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.service.run).toHaveBeenCalledTimes(2);
    await f.worker.onModuleDestroy();
  });

  it('backs off on outages and resets the delay after recovery', async () => {
    const f = fixture();
    f.service.run
      .mockRejectedValueOnce(new Error('429'))
      .mockRejectedValueOnce(new Error('503'));
    f.worker.start();
    await jest.advanceTimersByTimeAsync(0);
    await jest.advanceTimersByTimeAsync(1999);
    expect(f.service.run).toHaveBeenCalledTimes(1);
    await jest.advanceTimersByTimeAsync(1);
    expect(f.service.run).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(3999);
    expect(f.service.run).toHaveBeenCalledTimes(2);
    await jest.advanceTimersByTimeAsync(1);
    expect(f.service.run).toHaveBeenCalledTimes(3);
    await jest.advanceTimersByTimeAsync(1000);
    expect(f.service.run).toHaveBeenCalledTimes(4);
    await f.worker.onModuleDestroy();
  });

  it.each(['switch', 'credentials'])(
    'stays disabled without %s',
    async (reason) => {
      const f = fixture(
        reason === 'switch' ? { EMBEDDING_BACKFILL_ENABLED: false } : {},
      );
      if (reason === 'credentials') f.service.isEnabled.mockReturnValue(false);
      f.worker.start();
      await jest.advanceTimersByTimeAsync(10000);
      expect(f.service.run).not.toHaveBeenCalled();
      await f.worker.onModuleDestroy();
    },
  );

  it('aborts in-flight work on shutdown and does not schedule another pass', async () => {
    const f = fixture();
    let signal!: AbortSignal;
    f.service.run.mockImplementationOnce(async (s: AbortSignal) => {
      signal = s;
      await new Promise<void>((resolve) =>
        s.addEventListener('abort', () => resolve(), { once: true }),
      );
      throw new Error('aborted');
    });
    f.worker.start();
    await jest.advanceTimersByTimeAsync(0);
    await f.worker.onModuleDestroy();
    expect(signal.aborted).toBe(true);
    await jest.advanceTimersByTimeAsync(10000);
    expect(f.service.run).toHaveBeenCalledTimes(1);
  });
});
