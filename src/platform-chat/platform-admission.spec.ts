import { PlatformAdmission } from './platform-admission';

describe('platform request limits', () => {
  it('limits by IP across renewed sessions and resets the time window', () => {
    const limit = new PlatformAdmission();
    for (let i = 0; i < 20; i++) limit.acquire('s' + i, 'ip', 0)();
    expect(() => limit.acquire('new-session', 'ip', 1000)).toThrow();
    expect(() => limit.acquire('new-session', 'ip', 60000)()).not.toThrow();
  });
  it('bounds concurrent decoding and releases exactly once', () => {
    const limit = new PlatformAdmission(2);
    const a = limit.acquire('a', 'a');
    const b = limit.acquire('b', 'b');
    expect(() => limit.acquire('c', 'c')).toThrow();
    expect(() => limit.acquire('a', 'd')).toThrow();
    a();
    a();
    const c = limit.acquire('c', 'c');
    expect(() => limit.acquire('d', 'd')).toThrow();
    b();
    c();
  });
});
