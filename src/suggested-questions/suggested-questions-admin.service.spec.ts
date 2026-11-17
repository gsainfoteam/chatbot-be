import {
  BadRequestException,
  ConflictException,
  NotFoundException,
} from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { ConfigService } from '@nestjs/config';
import type { SuggestedQuestion } from '../db';
import type { OrganizationsRepository } from '../organizations/organizations.repository';
import type { AdminPrincipal } from '../organizations/organization.types';
import type { SuggestedQuestionsRepository } from './suggested-questions.repository';
import { SuggestedQuestionsAdminService } from './suggested-questions-admin.service';

const QUESTION_ID = '00000000-0000-0000-0000-0000000000a1';
const OWN_KEY_ID = '00000000-0000-0000-0000-0000000000b1';
const OTHER_KEY_ID = '00000000-0000-0000-0000-0000000000b2';

function principal(overrides: Partial<AdminPrincipal> = {}): AdminPrincipal {
  return {
    uuid: 'admin-1',
    email: 'admin@example.com',
    role: 'ADMIN',
    ...overrides,
  };
}

function question(overrides: Partial<SuggestedQuestion> = {}) {
  return {
    id: QUESTION_ID,
    widgetKeyId: OWN_KEY_ID,
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
    createdAt: new Date('2026-11-17T00:00:00Z'),
    updatedAt: new Date('2026-11-17T00:00:00Z'),
    ...overrides,
  } as SuggestedQuestion;
}

type RepoOverrides = Partial<{
  [K in keyof SuggestedQuestionsRepository]: unknown;
}>;

function build(
  overrides: RepoOverrides = {},
  { superAdmin = false }: { superAdmin?: boolean } = {},
) {
  const repo = {
    findWidgetKeyName: jest.fn(async () => 'GIST 위젯'),
    listAccessibleWidgetKeyIds: jest.fn(async () => [OWN_KEY_ID]),
    create: jest.fn(async () =>
      question({ source: 'ADMIN', status: 'APPROVED' }),
    ),
    findById: jest.fn(async () => ({
      question: question(),
      widgetKeyName: 'GIST 위젯',
    })),
    existsSameQuestion: jest.fn(async () => false),
    update: jest.fn(async () => question()),
    ...overrides,
  } as unknown as SuggestedQuestionsRepository;

  const organizationsRepo = {
    isCurrentSuperAdmin: jest.fn(async () => superAdmin),
  } as unknown as OrganizationsRepository;

  const config = { get: () => undefined } as unknown as ConfigService;

  return {
    service: new SuggestedQuestionsAdminService(
      repo,
      organizationsRepo,
      config,
    ),
    repo,
  };
}

describe('SuggestedQuestionsAdminService', () => {
  describe('create', () => {
    it('stores an admin-authored question as already approved', async () => {
      const { service, repo } = build();

      await service.create(principal(), {
        widgetKeyId: OWN_KEY_ID,
        question: '기숙사 언제 들어가요?',
        prompt: '입사 지침',
      });

      expect(repo.create).toHaveBeenCalledWith(
        expect.objectContaining({
          widgetKeyId: OWN_KEY_ID,
          source: 'ADMIN',
          status: 'APPROVED',
          createdByIdpUuid: 'admin-1',
          reviewedByIdpUuid: 'admin-1',
        }),
      );
    });

    it('hides widget keys the admin cannot reach behind a 404', async () => {
      const { service } = build();

      await expect(
        service.create(principal(), {
          widgetKeyId: OTHER_KEY_ID,
          question: '남의 위젯 질문',
          prompt: '지침',
        }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('lets a super admin reach any widget key', async () => {
      const { service, repo } = build({}, { superAdmin: true });

      await service.create(principal({ role: 'SUPER_ADMIN' }), {
        widgetKeyId: OTHER_KEY_ID,
        question: '질문',
        prompt: '지침',
      });

      expect(repo.create).toHaveBeenCalled();
    });

    it('reports a duplicate question as a conflict', async () => {
      const { service } = build({ create: jest.fn(async () => null) });

      await expect(
        service.create(principal(), {
          widgetKeyId: OWN_KEY_ID,
          question: '이미 있는 질문',
          prompt: '지침',
        }),
      ).rejects.toBeInstanceOf(ConflictException);
    });
  });

  describe('update', () => {
    it('rejects an empty patch', async () => {
      const { service } = build();

      await expect(
        service.update(principal(), QUESTION_ID, {}),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('records the reviewer when the status changes', async () => {
      const { service, repo } = build();

      await service.update(principal(), QUESTION_ID, { status: 'APPROVED' });

      expect(repo.update).toHaveBeenCalledWith(
        QUESTION_ID,
        expect.objectContaining({
          status: 'APPROVED',
          reviewedByIdpUuid: 'admin-1',
        }),
      );
    });

    it('does not record a review when only the wording changes', async () => {
      const { service, repo } = build();

      await service.update(principal(), QUESTION_ID, { prompt: '고친 지침' });

      const patch = jest.mocked(repo.update).mock.calls[0][1];
      expect(patch).toEqual({ prompt: '고친 지침' });
    });

    it('rejects a rename that collides with another question', async () => {
      const { service } = build({
        existsSameQuestion: jest.fn(async () => true),
      });

      await expect(
        service.update(principal(), QUESTION_ID, { question: '겹치는 질문' }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('hides questions on inaccessible widget keys behind a 404', async () => {
      const { service } = build({
        findById: jest.fn(async () => ({
          question: question({ widgetKeyId: OTHER_KEY_ID }),
          widgetKeyName: '남의 위젯',
        })),
      });

      await expect(
        service.update(principal(), QUESTION_ID, { status: 'APPROVED' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('getDetail', () => {
    it('exposes the prompt and a link to the source notice', async () => {
      const { service } = build();

      const dto = await service.getDetail(principal(), QUESTION_ID);

      expect(dto.prompt).toBe('답변 지침');
      expect(dto.noticeUrl).toBe('https://ziggle.gistory.me/notice/199293');
    });

    it('leaves the notice link empty for an admin-authored question', async () => {
      const { service } = build({
        findById: jest.fn(async () => ({
          question: question({ noticeId: null, noticeTitle: null }),
          widgetKeyName: 'GIST 위젯',
        })),
      });

      const dto = await service.getDetail(principal(), QUESTION_ID);

      expect(dto.noticeUrl).toBeNull();
    });
  });
});
