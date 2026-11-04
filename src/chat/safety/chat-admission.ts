import { HttpException, HttpStatus } from '@nestjs/common';

/** Process-local burst/concurrency guard. The database separately enforces five turns per session. */
export class ChatAdmission {
  private readonly sessions = new Set<string>();
  private readonly clients = new Map<
    string,
    { start: number; count: number; active: number }
  >();
  acquire(sessionId: string, client: string, now = Date.now()): () => void {
    for (const [key, value] of this.clients)
      if (value.active === 0 && now - value.start >= 60_000)
        this.clients.delete(key);
    let state = this.clients.get(client);
    if (!state) {
      if (this.clients.size >= 10_000) this.reject();
      state = { start: now, count: 0, active: 0 };
      this.clients.set(client, state);
    }
    if (now - state.start >= 60_000) {
      state.start = now;
      state.count = 0;
    }
    if (
      this.sessions.has(sessionId) ||
      this.sessions.size >= 32 ||
      state.active >= 3 ||
      state.count >= 20
    )
      this.reject();
    this.sessions.add(sessionId);
    state.count++;
    state.active++;
    let released = false;
    return () => {
      if (!released) {
        released = true;
        this.sessions.delete(sessionId);
        state.active--;
      }
    };
  }
  private reject(): never {
    throw new HttpException(
      '요청이 많습니다. 진행 중인 답변을 기다린 후 다시 시도해 주세요.',
      HttpStatus.TOO_MANY_REQUESTS,
    );
  }
}
export const chatAdmission = new ChatAdmission();
