import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import { plainToInstance } from 'class-transformer';
import { validateSync } from 'class-validator';
import type { SuggestedQuestion } from '../db';
import type { SuggestedQuestionsRepository } from './suggested-questions.repository';
import { SuggestedQuestionsAdminService } from './suggested-questions-admin.service';
import {
  CreateSuggestedQuestionDto,
  UpdateSuggestedQuestionDto,
} from './dto/suggested-question.dto';

const ADMIN = 'admin-1';
const QUESTION_ID = '00000000-0000-0000-0000-0000000000a1';
const FUTURE = '2099-12-31T23:59:59.000Z';
const PAST = '2020-01-01T00:00:00.000Z';

function question(overrides: Partial<SuggestedQuestion> = {}) {
  return {
    id: QUESTION_ID,
    question: '국가장학금 언제까지 신청해요?',
    normalizedQuestion: '국가장학금 언제까지 신청해요',
    prompt: '답변 지침',
    source: 'AI',
    status: 'PENDING',
    noticeId: 199293,
    noticeTitle: '[학사] 국가장학금 안내',
    createdByIdpUuid: null,
    reviewedByIdpUuid: null,
    reviewedAt: null,
    expiresAt: null,
    createdAt: new Date('2026-11-17T00:00:00Z'),
    updatedAt: new Date('2026-11-17T00:00:00Z'),
    ...overrides,
  } as SuggestedQuestion;
}

type RepoOverrides = Partial<{
  [K in keyof SuggestedQuestionsRepository]: unknown;
}>;

function build(overrides: RepoOverrides = {}) {
  const repo = {
    create: jest.fn(async () =>
      question({ source: 'ADMIN', status: 'APPROVED' }),
    ),
    findById: jest.fn(async () => question()),
    existsSameQuestion: jest.fn(async () => false),
    update: jest.fn(async () => question()),
    ...overrides,
  } as unknown as SuggestedQuestionsRepository;

  const config = { get: () => undefined } as unknown as ConfigService;

  return { service: new SuggestedQuestionsAdminService(repo, config), repo };
}

describe('SuggestedQuestionsAdminService', () => {
  describe('create', () => {
    it('stores an admin-authored question as already approved', async () => {
      const { service, repo } = build();

      await service.create(ADMIN, {
        question: '기숙사 언제 들어가요?',
        prompt: '입사 지침',
        expiresAt: FUTURE,
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'ADMIN',
          status: 'APPROVED',
          createdByIdpUuid: ADMIN,
          reviewedByIdpUuid: ADMIN,
          expiresAt: new Date(FUTURE),
        }),
      );
    });

    it('stores null as no expiry', async () => {
      const { service, repo } = build();

      await service.create(ADMIN, {
        question: '학교 Wi-Fi는 어떻게 설정하나요?',
        prompt: '와이파이 지침',
        expiresAt: null,
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ expiresAt: null }),
      );
    });

    it('stores no prompt when the admin leaves it out', async () => {
      // 관리자 질문은 대개 학교 문서에 있는 내용이라 질문을 그대로 보내면 된다.
      const { service, repo } = build();

      await service.create(ADMIN, {
        question: '학교 Wi-Fi는 어떻게 설정하나요?',
        expiresAt: null,
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({ prompt: null }),
      );
    });

    it('clears the prompt when null is sent on update', async () => {
      const { service, repo } = build();

      await service.update(ADMIN, QUESTION_ID, { prompt: null });

      const patch = jest.mocked(repo.update).mock.calls[0][1];
      expect(patch).toEqual({ prompt: null });
    });

    it('rejects an expiry in the past', async () => {
      const { service, repo } = build();

      await expect(
        service.create(ADMIN, {
          question: '질문',
          prompt: '지침',
          expiresAt: PAST,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.create).not.toHaveBeenCalled();
    });

    it('reports a duplicate question as a conflict', async () => {
      const { service } = build({ create: jest.fn(async () => null) });

      await expect(
        service.create(ADMIN, {
          question: '이미 있는 질문',
          prompt: '지침',
          expiresAt: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('rejects an empty patch', async () => {
      const { service } = build();

      await expect(
        service.update(ADMIN, QUESTION_ID, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('records the reviewer and expiry when approving', async () => {
      const { service, repo } = build();

      await service.update(ADMIN, QUESTION_ID, {
        status: 'APPROVED',
        expiresAt: FUTURE,
      });

      expect(repo.update).toHaveBeenCalledWith(
        QUESTION_ID,
        expect.objectContaining({
          status: 'APPROVED',
          reviewedByIdpUuid: ADMIN,
          expiresAt: new Date(FUTURE),
        }),
      );
    });

    it('refuses to approve without an expiry', async () => {
      // 기한 없이 승인되면 첫 화면에서 영영 내려가지 않는다. 무기한도 null로 명시해야 한다.
      const { service, repo } = build();

      await expect(
        service.update(ADMIN, QUESTION_ID, { status: 'APPROVED' }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('approves with no expiry when null is sent explicitly', async () => {
      const { service, repo } = build();

      await service.update(ADMIN, QUESTION_ID, {
        status: 'APPROVED',
        expiresAt: null,
      });

      expect(repo.update).toHaveBeenCalledWith(
        QUESTION_ID,
        expect.objectContaining({ status: 'APPROVED', expiresAt: null }),
      );
    });

    it('rejects without an expiry only when approving', async () => {
      const { service, repo } = build();

      await service.update(ADMIN, QUESTION_ID, { status: 'REJECTED' });

      const patch = jest.mocked(repo.update).mock.calls[0][1];
      expect(patch.status).toBe('REJECTED');
      expect(patch).not.toHaveProperty('expiresAt');
    });

    it('extends the expiry alone without recording a review', async () => {
      const { service, repo } = build();

      await service.update(ADMIN, QUESTION_ID, { expiresAt: FUTURE });

      const patch = jest.mocked(repo.update).mock.calls[0][1];
      expect(patch).toEqual({ expiresAt: new Date(FUTURE) });
    });

    it('rejects an expiry in the past', async () => {
      const { service, repo } = build();

      await expect(
        service.update(ADMIN, QUESTION_ID, {
          status: 'APPROVED',
          expiresAt: PAST,
        }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(repo.update).not.toHaveBeenCalled();
    });

    it('does not record a review when only the wording changes', async () => {
      const { service, repo } = build();

      await service.update(ADMIN, QUESTION_ID, { prompt: '고친 지침' });

      const patch = jest.mocked(repo.update).mock.calls[0][1];
      expect(patch).toEqual({ prompt: '고친 지침' });
    });

    it('rejects a rename that collides with another question', async () => {
      const { service } = build({
        existsSameQuestion: jest.fn(async () => true),
      });

      await expect(
        service.update(ADMIN, QUESTION_ID, { question: '겹치는 질문' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('reports a missing question as a 404', async () => {
      const { service } = build({ findById: jest.fn(async () => null) });

      await expect(
        service.update(ADMIN, QUESTION_ID, {
          status: 'APPROVED',
          expiresAt: null,
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getDetail', () => {
    it('exposes the prompt and a link to the source notice', async () => {
      const { service } = build();

      const dto = await service.getDetail(QUESTION_ID);

      expect(dto.prompt).toBe('답변 지침');
      expect(dto.noticeUrl).toBe('https://ziggle.gistory.me/notice/199293');
    });

    it('leaves the notice link empty for an admin-authored question', async () => {
      const { service } = build({
        findById: jest.fn(async () =>
          question({ noticeId: null, noticeTitle: null }),
        ),
      });

      const dto = await service.getDetail(QUESTION_ID);

      expect(dto.noticeUrl).toBeNull();
    });

    it('flags a question whose expiry has passed', async () => {
      const { service } = build({
        findById: jest.fn(async () =>
          question({
            status: 'APPROVED',
            expiresAt: new Date(PAST),
          }),
        ),
      });

      const dto = await service.getDetail(QUESTION_ID);

      expect(dto.expired).toBe(true);
    });

    it('treats a null expiry as never expiring', async () => {
      const { service } = build();

      const dto = await service.getDetail(QUESTION_ID);

      expect(dto.expiresAt).toBeNull();
      expect(dto.expired).toBe(false);
    });
  });
});

describe('expiresAt validation', () => {
  function validate<T extends object>(
    cls: new () => T,
    body: Record<string, unknown>,
  ) {
    return validateSync(plainToInstance(cls, body), {
      whitelist: true,
      forbidNonWhitelisted: true,
    });
  }

  const create = {
    question: '질문',
    prompt: '지침',
  };

  it('requires expiresAt when creating', () => {
    expect(validate(CreateSuggestedQuestionDto, create)).toHaveLength(1);
  });

  it('accepts null or a date when creating', () => {
    expect(
      validate(CreateSuggestedQuestionDto, { ...create, expiresAt: null }),
    ).toHaveLength(0);
    expect(
      validate(CreateSuggestedQuestionDto, { ...create, expiresAt: FUTURE }),
    ).toHaveLength(0);
  });

  it('rejects a non-date string', () => {
    expect(
      validate(CreateSuggestedQuestionDto, { ...create, expiresAt: '내일' }),
    ).toHaveLength(1);
    expect(
      validate(UpdateSuggestedQuestionDto, { expiresAt: '내일' }),
    ).toHaveLength(1);
  });

  it('keeps expiresAt optional on update and allows null', () => {
    expect(
      validate(UpdateSuggestedQuestionDto, { prompt: '지침' }),
    ).toHaveLength(0);
    expect(
      validate(UpdateSuggestedQuestionDto, { expiresAt: null }),
    ).toHaveLength(0);
  });

  it('lets an admin create a question without a prompt', () => {
    expect(
      validate(CreateSuggestedQuestionDto, { ...create, expiresAt: null }),
    ).toHaveLength(0);
    expect(
      validate(CreateSuggestedQuestionDto, {
        ...create,
        prompt: '   ',
        expiresAt: null,
      }),
    ).toHaveLength(0);
  });

  it('accepts null to clear the prompt on update', () => {
    expect(validate(UpdateSuggestedQuestionDto, { prompt: null })).toHaveLength(
      0,
    );
  });
});
