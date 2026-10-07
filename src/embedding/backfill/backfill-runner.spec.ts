import {
  runBackfill,
  type BackfillChunk,
  type BackfillStore,
} from './backfill-runner';

const chunk = (id: string): BackfillChunk => ({
  id,
  documentTitle: 'title',
  path: id,
  description: '',
  content: id,
});
const options = () => ({ batchSize: 2, signal: new AbortController().signal });

function fixture(ids = ['a', 'b', 'c']) {
  const rows = ids.map(chunk);
  const saved = new Set<string>();
  const store: BackfillStore = {
    upperBound: jest.fn(async () => rows.at(-1)?.id ?? null),
    readBatch: jest.fn(async (after, through, limit, all) =>
      rows
        .filter(
          (row) =>
            (!after || row.id > after) &&
            row.id <= through &&
            (all || !saved.has(row.id)),
        )
        .slice(0, limit),
    ),
    saveBatch: jest.fn(async (batch) => {
      batch.forEach((row) => saved.add(row.id));
      return batch.length;
    }),
  };
  const embed = jest.fn(async (texts: string[]) => texts.map(() => [1]));
  return { rows, saved, store, embed };
}

describe('embedding backfill runner', () => {
  it('pages through missing chunks and skips completed work on restart', async () => {
    const f = fixture();
    expect(await runBackfill(f.store, f.embed, options())).toEqual({
      selected: 3,
      saved: 3,
      failed: 0,
    });
    expect(f.embed.mock.calls.map(([texts]) => texts.length)).toEqual([2, 1]);
    f.embed.mockClear();
    expect(await runBackfill(f.store, f.embed, options())).toEqual({
      selected: 0,
      saved: 0,
      failed: 0,
    });
    expect(f.embed).not.toHaveBeenCalled();
    await runBackfill(f.store, f.embed, { ...options(), all: true });
    expect(f.embed).toHaveBeenCalledTimes(2);
  });

  it('does not call the API on an empty database', async () => {
    const f = fixture([]);
    await runBackfill(f.store, f.embed, options());
    expect(f.embed).not.toHaveBeenCalled();
  });

  it('retains earlier batches after an outage and resumes them without re-embedding', async () => {
    const f = fixture();
    f.embed.mockRejectedValueOnce(new Error('API unavailable'));
    await expect(runBackfill(f.store, f.embed, options())).rejects.toThrow(
      'API unavailable',
    );
    expect(f.saved.size).toBe(0);
    f.embed.mockClear();
    f.embed
      .mockResolvedValueOnce([[1], [1]])
      .mockRejectedValueOnce(new Error('API unavailable'));
    await expect(runBackfill(f.store, f.embed, options())).rejects.toThrow(
      'API unavailable',
    );
    expect([...f.saved]).toEqual(['a', 'b']);
    f.embed.mockClear();
    await runBackfill(f.store, f.embed, options());
    expect(f.embed).toHaveBeenCalledTimes(1);
    expect(f.embed.mock.calls[0][0]).toHaveLength(1);
  });

  it('isolates bad input and advances the cursor so later chunks are still processed', async () => {
    const f = fixture();
    f.embed.mockImplementation(async (texts) => {
      if (texts.some((text) => text.endsWith('\na')))
        throw Object.assign(new Error('Invalid input'), {
          response: { status: 400, data: { error: { code: 'invalid_input' } } },
        });
      return texts.map(() => [1]);
    });
    expect(await runBackfill(f.store, f.embed, options())).toEqual({
      selected: 3,
      saved: 2,
      failed: 1,
    });
    expect([...f.saved]).toEqual(['b', 'c']);
  });

  it.each([400, 401, 429, 503])(
    'stops on systemic HTTP %s errors without splitting requests',
    async (status) => {
      const f = fixture();
      f.embed.mockRejectedValue({ response: { status } });
      await expect(runBackfill(f.store, f.embed, options())).rejects.toEqual({
        response: { status },
      });
      expect(f.embed).toHaveBeenCalledTimes(1);
    },
  );

  it('does not save a response after shutdown or loss of lock ownership', async () => {
    const f = fixture();
    const abort = new AbortController();
    f.embed.mockImplementation(async (texts) => {
      abort.abort();
      return texts.map(() => [1]);
    });
    await expect(
      runBackfill(f.store, f.embed, { ...options(), signal: abort.signal }),
    ).rejects.toThrow();
    expect(f.store.saveBatch).not.toHaveBeenCalled();
  });

  it('defers uploads beyond the initial upper bound until the next pass', async () => {
    const f = fixture();
    f.embed.mockImplementation(async (texts) => {
      f.rows.push(chunk('z'));
      return texts.map(() => [1]);
    });
    expect((await runBackfill(f.store, f.embed, options())).saved).toBe(3);
    expect(f.saved.has('z')).toBe(false);
  });
});
