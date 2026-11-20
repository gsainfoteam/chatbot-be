import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { plainToInstance } from 'class-transformer';
import { validate } from 'class-validator';
import type { Database } from '../db';
import { QuestionLimitDto } from '../common/dto/question-limit.dto';
import { AdminService } from './admin.service';

const owner = 'owner-uuid';
const row = {
  id: 'key-1',
  name: 'Main',
  secretKey: 'wk_live_test',
  status: 'ACTIVE',
  allowedDomains: ['example.com'],
  allowedAppIds: [],
  createdByIdpUuid: owner,
  questionLimit: null as number | null,
  questionLimitWindowSeconds: null as number | null,
  createdAt: new Date('2026-11-20T00:00:00.000Z'),
};

const createService = (existing: Partial<typeof row> | null = {}) => {
  const updates: Record<string, unknown>[] = [];
  const current = existing && { ...row, ...existing };
  const db = {
    select: () => ({
      from: () => ({
        where: () => ({ limit: async () => (current ? [current] : []) }),
      }),
    }),
    update: () => ({
      set: (values: Record<string, unknown>) => {
        updates.push(values);
        return {
          where: () => ({ returning: async () => [{ ...current, ...values }] }),
        };
      },
    }),
  };
  return { service: new AdminService(db as unknown as Database), updates };
};

describe('AdminService question limit', () => {
  it('lets the owner set a limit and returns it on the widget key', async () => {
    const { service, updates } = createService();

    const result = await service.setQuestionLimit('key-1', owner, {
      maxQuestions: 20,
      windowSeconds: 86400,
    });

    expect(updates[0]).toMatchObject({
      questionLimit: 20,
      questionLimitWindowSeconds: 86400,
    });
    expect(result.questionLimit).toEqual({
      maxQuestions: 20,
      windowSeconds: 86400,
    });
  });

  it('clears the limit back to unlimited', async () => {
    const { service, updates } = createService({
      questionLimit: 20,
      questionLimitWindowSeconds: 86400,
    });

    const result = await service.setQuestionLimit('key-1', owner, null);

    expect(updates[0]).toMatchObject({
      questionLimit: null,
      questionLimitWindowSeconds: null,
    });
    expect(result.questionLimit).toBeNull();
  });

  it('rejects non-owners, revoked keys and unknown keys', async () => {
    await expect(
      createService().service.setQuestionLimit('key-1', 'collaborator', null),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      createService({ status: 'REVOKED' }).service.setQuestionLimit(
        'key-1',
        owner,
        null,
      ),
    ).rejects.toBeInstanceOf(ForbiddenException);
    await expect(
      createService(null).service.setQuestionLimit('missing', owner, null),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('accepts only whole numbers within the allowed ranges', async () => {
    const errors = (input: Record<string, unknown>) =>
      validate(plainToInstance(QuestionLimitDto, input));

    expect(await errors({ maxQuestions: 1, windowSeconds: 60 })).toHaveLength(
      0,
    );
    expect(
      await errors({ maxQuestions: 10000, windowSeconds: 2592000 }),
    ).toHaveLength(0);
    for (const invalid of [
      { maxQuestions: 0, windowSeconds: 60 },
      { maxQuestions: 10001, windowSeconds: 60 },
      { maxQuestions: 1, windowSeconds: 59 },
      { maxQuestions: 1, windowSeconds: 2592001 },
      { maxQuestions: 1.5, windowSeconds: 60 },
      { maxQuestions: 1 },
    ]) {
      expect(await errors(invalid)).not.toHaveLength(0);
    }
  });
});
