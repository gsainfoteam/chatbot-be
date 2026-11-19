import { ChatAdmission } from './chat-admission';

describe('chat burst admission', () => {
  it('limits concurrent requests and releases a session exactly once', () => {
    const a = new ChatAdmission();
    const release = a.acquire('s1', 'client', 0);
    expect(() => a.acquire('s1', 'other', 0)).toThrow();
    release();
    release();
    const r = a.acquire('s1', 'client', 0);
    r();
  });
  it('counts requests across newly created sessions and recovers after the window', () => {
    const a = new ChatAdmission();
    for (let n = 0; n < 20; n++) a.acquire('s' + n, 'client', 0)();
    expect(() => a.acquire('fresh-session', 'client', 1)).toThrow();
    expect(() => a.acquire('fresh-session', 'client', 60001)()).not.toThrow();
  });
  it('limits per-client concurrency even across sessions', () => {
    const a = new ChatAdmission();
    const releases = [0, 1, 2].map((n) => a.acquire('s' + n, 'client', 0));
    expect(() => a.acquire('s3', 'client', 0)).toThrow();
    releases[0]();
    expect(() => a.acquire('s3', 'client', 1)).not.toThrow();
  });
});
