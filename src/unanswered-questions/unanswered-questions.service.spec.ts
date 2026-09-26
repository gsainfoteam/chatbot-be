import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { UnansweredQuestion } from '../db';
import type { OrganizationsRepository } from '../organizations/organizations.repository';
import type { AdminPrincipal } from '../organizations/organization.types';
import type { UploadService } from '../upload/upload.service';
import type { DocumentListItemDto } from '../upload/dto/document-list-item.dto';
import type {
  UnansweredQuestionRecord,
  UnansweredQuestionsRepository,
} from './unanswered-questions.repository';
import { UnansweredQuestionsService } from './unanswered-questions.service';
import type { ListUnansweredQuestionsQueryDto } from './dto/unanswered-question.dto';

const QUESTION_ID = '00000000-0000-0000-0000-0000000000a1';
const OWN_KEY_ID = '00000000-0000-0000-0000-0000000000b1';
const OTHER_KEY_ID = '00000000-0000-0000-0000-0000000000b2';
const DOCUMENT_ID = '00000000-0000-0000-0000-0000000000c1';

function principal(overrides: Partial<AdminPrincipal> = {}): AdminPrincipal {
  return {
    uuid: 'admin-1',
    email: 'admin@example.com',
    role: 'ADMIN',
    ...overrides,
  };
}

function question(
  overrides: Partial<UnansweredQuestion> = {},
): UnansweredQuestion {
  return {
    id: QUESTION_ID,
    widgetKeyId: OWN_KEY_ID,
    question: '부산에서 외국인도 은행 계좌를 만들 수 있나요?',
    normalizedQuestion: '부산에서 외국인도 은행 계좌를 만들 수 있나요',
    language: 'KO',
    askCount: 3,
    status: 'OPEN',
    lastSessionId: null,
    lastAnswerMessageId: 'message-1',
    resolvedDocumentId: null,
    resolvedByIdpUuid: null,
    resolvedAt: null,
    firstAskedAt: new Date('2026-09-01T00:00:00Z'),
    lastAskedAt: new Date('2026-09-11T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-11T00:00:00Z'),
    ...overrides,
  };
}

function record(
  overrides: Partial<UnansweredQuestion> = {},
): UnansweredQuestionRecord {
  return {
    question: question(overrides),
    widgetKeyName: '학생 포털',
    document: null,
  };
}

const listQuery: ListUnansweredQuestionsQueryDto = {
  page: 1,
  size: 20,
  status: 'all',
  sort: 'count',
  order: 'desc',
};

function createService(options: { superAdmin?: boolean } = {}) {
  const repo = {
    list: jest.fn<UnansweredQuestionsRepository['list']>(async () => ({
      rows: [record()],
      filteredTotal: 1,
    })),
    findById: jest.fn<UnansweredQuestionsRepository['findById']>(async () =>
      record(),
    ),
    findLastAnswer: jest.fn<UnansweredQuestionsRepository['findLastAnswer']>(
      async () => ({
        messageId: 'message-1',
        content: '관련 자료를 찾지 못했습니다.',
        createdAt: new Date('2026-09-11T00:00:00Z'),
      }),
    ),
    listAccessibleWidgetKeyIds: jest.fn<
      UnansweredQuestionsRepository['listAccessibleWidgetKeyIds']
    >(async () => [OWN_KEY_ID]),
    updateStatus: jest.fn<UnansweredQuestionsRepository['updateStatus']>(
      async () => true,
    ),
    linkDocument: jest.fn<UnansweredQuestionsRepository['linkDocument']>(
      async () => true,
    ),
  };
  const organizationsRepo = {
    isCurrentSuperAdmin: jest.fn(async () => options.superAdmin ?? false),
  };
  const createdDocument = {
    id: DOCUMENT_ID,
    sourceType: 'text',
    status: 'queued',
  } as DocumentListItemDto;
  const uploadService = {
    createTextDocument: jest.fn<UploadService['createTextDocument']>(
      async () => createdDocument,
    ),
    upload: jest.fn<UploadService['upload']>(async () => ({
      ...createdDocument,
      sourceType: 'pdf',
    })),
  };

  return {
    service: new UnansweredQuestionsService(
      repo as unknown as UnansweredQuestionsRepository,
      organizationsRepo as unknown as OrganizationsRepository,
      uploadService as unknown as UploadService,
    ),
    repo,
    uploadService,
  };
}

describe('UnansweredQuestionsService access', () => {
  it('lists every widget key for SUPER_ADMIN', async () => {
    const { service, repo } = createService({ superAdmin: true });

    await service.list(principal({ role: 'SUPER_ADMIN' }), listQuery);

    expect(repo.listAccessibleWidgetKeyIds).not.toHaveBeenCalled();
    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({
        widgetKeyIds: null,
        sort: 'count',
      }),
    );
  });

  it('limits other admins to owned or collaborated widget keys', async () => {
    const { service, repo } = createService();

    const result = await service.list(principal(), listQuery);

    expect(repo.listAccessibleWidgetKeyIds).toHaveBeenCalledWith('admin-1');
    expect(repo.list).toHaveBeenCalledWith(
      expect.objectContaining({ widgetKeyIds: [OWN_KEY_ID] }),
    );
    expect(result.page).toEqual({
      number: 1,
      size: 20,
      filteredTotal: 1,
      totalPages: 1,
      hasNext: false,
      hasPrevious: false,
    });
    expect(result.items[0]).toEqual(
      expect.objectContaining({
        id: QUESTION_ID,
        widgetKeyName: '학생 포털',
        askCount: 3,
        askedAgainAfterResolved: false,
      }),
    );
  });

  it('hides questions of inaccessible widget keys as 404', async () => {
    const { service, repo, uploadService } = createService();
    repo.findById.mockResolvedValue(record({ widgetKeyId: OTHER_KEY_ID }));

    await expect(
      service.getDetail(QUESTION_ID, principal()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.updateStatus(QUESTION_ID, 'DISMISSED', principal()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.registerTextDocument(
        QUESTION_ID,
        { title: '계좌', content: '본문' },
        principal(),
      ),
    ).rejects.toBeInstanceOf(NotFoundException);

    expect(repo.updateStatus).not.toHaveBeenCalled();
    expect(uploadService.createTextDocument).not.toHaveBeenCalled();
  });

  it('includes the last answer in the detail', async () => {
    const { service, repo } = createService();

    const detail = await service.getDetail(QUESTION_ID, principal());

    expect(repo.findLastAnswer).toHaveBeenCalledWith('message-1');
    expect(detail.lastAnswer?.content).toBe('관련 자료를 찾지 못했습니다.');
  });
});

describe('UnansweredQuestionsService knowledge registration', () => {
  it('creates a text document and links it to the question', async () => {
    const { service, repo, uploadService } = createService();

    const result = await service.registerTextDocument(
      QUESTION_ID,
      {
        title: '외국인 계좌 개설',
        content: '여권과 외국인등록증이 필요합니다.',
        organizationId: '00000000-0000-0000-0000-000000000010',
      },
      principal(),
    );

    expect(uploadService.createTextDocument).toHaveBeenCalledWith(
      '외국인 계좌 개설',
      '여권과 외국인등록증이 필요합니다.',
      principal(),
      '00000000-0000-0000-0000-000000000010',
      undefined,
    );
    expect(repo.linkDocument).toHaveBeenCalledWith(
      QUESTION_ID,
      DOCUMENT_ID,
      'admin-1',
    );
    expect(result.document.id).toBe(DOCUMENT_ID);
  });

  it('uploads a PDF and links it to the question', async () => {
    const { service, repo, uploadService } = createService();

    await service.registerPdfDocument(
      QUESTION_ID,
      {
        file: Buffer.from('%PDF-test'),
        filename: 'bank.pdf',
        title: '은행 안내',
      },
      principal(),
    );

    expect(uploadService.upload).toHaveBeenCalledWith(
      Buffer.from('%PDF-test'),
      'bank.pdf',
      '은행 안내',
      principal(),
      undefined,
      undefined,
    );
    expect(repo.linkDocument).toHaveBeenCalledWith(
      QUESTION_ID,
      DOCUMENT_ID,
      'admin-1',
    );
  });

  it('flags questions asked again after being resolved', async () => {
    const { service, repo } = createService();
    repo.findById.mockResolvedValue(
      record({
        status: 'RESOLVED',
        resolvedAt: new Date('2026-09-05T00:00:00Z'),
        lastAskedAt: new Date('2026-09-11T00:00:00Z'),
      }),
    );

    const updated = await service.updateStatus(
      QUESTION_ID,
      'RESOLVED',
      principal(),
    );

    expect(repo.updateStatus).toHaveBeenCalledWith(
      QUESTION_ID,
      'RESOLVED',
      'admin-1',
    );
    expect(updated.askedAgainAfterResolved).toBe(true);
  });
});
