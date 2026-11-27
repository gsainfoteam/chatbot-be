import { HttpException, HttpStatus } from '@nestjs/common';

/** Process-local limits; independent of token renewal and conversation IDs. */
export class PlatformAdmission {
  private readonly clients = new Map<
    string,
    { start: number; count: number }
  >();
  private readonly sessions = new Set<string>();

  constructor(private readonly concurrentLimit = 4) {}

  acquire(sessionId: string, ip: string, now = Date.now()): () => void {
    for (const [key, value] of this.clients) {
      if (now - value.start >= 60_000) this.clients.delete(key);
    }
    const client = this.clients.get(ip) ?? { start: now, count: 0 };
    if (
      (!this.clients.has(ip) && this.clients.size >= 10_000) ||
      client.count >= 20 ||
      this.sessions.has(sessionId) ||
      this.sessions.size >= this.concurrentLimit
    ) {
      throw new HttpException(
        '요청이 많습니다. 잠시 후 다시 시도해 주세요.',
        HttpStatus.TOO_MANY_REQUESTS,
      );
    }
    this.clients.set(ip, client);
    client.count++;
    this.sessions.add(sessionId);
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.sessions.delete(sessionId);
      }
    };
  }
}
