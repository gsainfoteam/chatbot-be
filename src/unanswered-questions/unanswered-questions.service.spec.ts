import { NotFoundException } from '@nestjs/common';
import { describe, expect, it, jest } from '@jest/globals';
import type { UnansweredQuestion } from '../db';
import type { OrganizationsRepository } from '../organizations/organizations.repository';
import type { AdminPrincipal } from '../organizations/organization.types';
import type { UploadService } from '../upload/upload.service';
import type { DocumentListItemDto } from '../upload/dto/document-list-item.dto';
import type {
  LinkedDocumentRecord,
  UnansweredQuestionRecord,
  UnansweredQuestionsRepository,
} from './unanswered-questions.repository';
import { UnansweredQuestionsService } from './unanswered-questions.service';
import type { ListUnansweredQuestionsQueryDto } from './dto/unanswered-question.dto';

const QUESTION_ID = '00000000-0000-0000-0000-0000000000a1';
const OWN_KEY_ID = '00000000-0000-0000-0000-0000000000b1';
const OTHER_KEY_ID = '00000000-0000-0000-0000-0000000000b2';
const DOCUMENT_ID = '00000000-0000-0000-0000-0000000000c1';
const RESOLVED_AT = new Date('2026-09-12T00:00:00Z');

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
    occurrenceCount: 3,
    status: 'open',
    lastSessionId: null,
    lastAnswerMessageId: 'message-1',
    resolvedDocumentId: null,
    resolvedByIdpUuid: null,
    resolvedAt: null,
    lastAskedAt: new Date('2026-09-11T00:00:00Z'),
    createdAt: new Date('2026-09-01T00:00:00Z'),
    updatedAt: new Date('2026-09-11T00:00:00Z'),
    ...overrides,
  };
}

function linkedDocument(
  overrides: Partial<LinkedDocumentRecord> = {},
): LinkedDocumentRecord {
  return {
    id: DOCUMENT_ID,
    title: '외국인 계좌 개설',
    resourceName: '외국인 계좌 개설',
    status: 'queued',
    sourceType: 'text',
    sourceText: '여권과 외국인등록증이 필요합니다.',
    isActive: true,
    ...overrides,
  };
}

function record(
  overrides: Partial<UnansweredQuestion> = {},
  document: LinkedDocumentRecord | null = null,
): UnansweredQuestionRecord {
  return {
    question: question(overrides),
    widgetKeyName: '학생 포털',
    document,
  };
}

function resolvedRecord(document: LinkedDocumentRecord) {
  return record(
    {
      status: 'resolved',
      resolvedAt: RESOLVED_AT,
      resolvedDocumentId: document.id,
      resolvedByIdpUuid: 'admin-1',
    },
    document,
  );
}

const listQuery: ListUnansweredQuestionsQueryDto = {
  page: 1,
  size: 20,
  status: 'open',
  sort: 'created',
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
        status: 'open',
        sort: 'created',
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
  });

  it('maps rows to the dashboard question shape', async () => {
    const { service } = createService();

    const result = await service.list(principal(), listQuery);

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        id: QUESTION_ID,
        question: '부산에서 외국인도 은행 계좌를 만들 수 있나요?',
        createdAt: new Date('2026-09-01T00:00:00Z'),
        status: 'open',
        occurrenceCount: 3,
        resolvedAt: null,
        injectedKnowledge: null,
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
      service.updateStatus(QUESTION_ID, 'resolved', principal()),
    ).rejects.toBeInstanceOf(NotFoundException);
    await expect(
      service.injectTextKnowledge(QUESTION_ID, { text: '본문' }, principal()),
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

describe('UnansweredQuestionsService knowledge injection', () => {
  it('injects text knowledge titled after the question and returns the resolved question', async () => {
    const { service, repo, uploadService } = createService();
    repo.findById
      .mockResolvedValueOnce(record())
      .mockResolvedValueOnce(resolvedRecord(linkedDocument()));

    const result = await service.injectTextKnowledge(
      QUESTION_ID,
      { text: '여권과 외국인등록증이 필요합니다.' },
      principal(),
    );

    expect(uploadService.createTextDocument).toHaveBeenCalledWith(
      '부산에서 외국인도 은행 계좌를 만들 수 있나요?',
      '여권과 외국인등록증이 필요합니다.',
      principal(),
      undefined,
      undefined,
    );
    expect(repo.linkDocument).toHaveBeenCalledWith(
      QUESTION_ID,
      DOCUMENT_ID,
      'admin-1',
    );
    expect(result).toEqual(
      expect.objectContaining({
        status: 'resolved',
        resolvedAt: RESOLVED_AT,
        injectedKnowledge: {
          type: 'text',
          injectedAt: RESOLVED_AT,
          text: '여권과 외국인등록증이 필요합니다.',
          documentId: DOCUMENT_ID,
          documentTitle: '외국인 계좌 개설',
          documentStatus: 'queued',
          documentActive: true,
        },
      }),
    );
  });

  it('uses an explicit title and truncates long questions for the default title', async () => {
    const { service, repo, uploadService } = createService();
    repo.findById.mockResolvedValue(record({ question: '가'.repeat(300) }));

    await service.injectTextKnowledge(
      QUESTION_ID,
      { text: '본문', title: '  직접 입력한 제목 ' },
      principal(),
    );
    await service.injectTextKnowledge(
      QUESTION_ID,
      { text: '본문' },
      principal(),
    );

    expect(uploadService.createTextDocument.mock.calls[0]?.[0]).toBe(
      '직접 입력한 제목',
    );
    expect(uploadService.createTextDocument.mock.calls[1]?.[0]).toBe(
      '가'.repeat(100),
    );
  });

  it('injects a PDF and reports its file name', async () => {
    const { service, repo, uploadService } = createService();
    repo.findById.mockResolvedValueOnce(record()).mockResolvedValueOnce(
      resolvedRecord(
        linkedDocument({
          sourceType: 'pdf',
          sourceText: null,
          resourceName: 'bank',
        }),
      ),
    );

    const result = await service.injectPdfKnowledge(
      QUESTION_ID,
      {
        file: Buffer.from('%PDF-test'),
        filename: 'bank.pdf',
        title: 'bank',
      },
      principal(),
    );

    expect(uploadService.upload).toHaveBeenCalledWith(
      Buffer.from('%PDF-test'),
      'bank.pdf',
      'bank',
      principal(),
      undefined,
      undefined,
    );
    expect(result.injectedKnowledge).toEqual(
      expect.objectContaining({ type: 'pdf', fileName: 'bank.pdf' }),
    );
    expect(result.injectedKnowledge).not.toHaveProperty('text');
  });

  it('resolves without knowledge and flags questions asked again afterwards', async () => {
    const { service, repo } = createService();
    repo.findById.mockResolvedValue(
      record({
        status: 'resolved',
        resolvedAt: new Date('2026-09-05T00:00:00Z'),
        lastAskedAt: new Date('2026-09-11T00:00:00Z'),
      }),
    );

    const updated = await service.updateStatus(
      QUESTION_ID,
      'resolved',
      principal(),
    );

    expect(repo.updateStatus).toHaveBeenCalledWith(
      QUESTION_ID,
      'resolved',
      'admin-1',
    );
    expect(updated.injectedKnowledge).toBeNull();
    expect(updated.askedAgainAfterResolved).toBe(true);
  });
});
