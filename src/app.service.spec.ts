import { describe, expect, it } from '@jest/globals';
import { AppService } from './app.service';

describe('AppService', () => {
  const service = new AppService();

  it('returns Hello World for getHello', () => {
    expect(service.getHello()).toBe('Hello World!');
  });

  it('returns a liveness payload for getHealth', () => {
    expect(service.getHealth()).toEqual({ status: 'ok' });
  });
});
