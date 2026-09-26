import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { UnansweredQuestionStatus } from '../db';
import { OrganizationsRepository } from '../organizations/organizations.repository';
import type { AdminPrincipal } from '../organizations/organization.types';
import { UploadService } from '../upload/upload.service';
import type { DocumentListItemDto } from '../upload/dto/document-list-item.dto';
import type { PdfUploadForm } from '../upload/pdf-upload-form';
import {
  UnansweredQuestionsRepository,
  type UnansweredQuestionRecord,
} from './unanswered-questions.repository';
import type {
  InjectedKnowledgeDto,
  InjectTextKnowledgeDto,
  ListUnansweredQuestionsQueryDto,
  UnansweredQuestionDetailDto,
  UnansweredQuestionDto,
  UnansweredQuestionsResponseDto,
} from './dto/unanswered-question.dto';

/** 제목 없이 텍스트 지식을 등록할 때 질문에서 가져올 최대 제목 길이 */
const DEFAULT_TITLE_MAX_CHARS = 100;

/**
 * 미답변 질문 조회·처리와 질문별 지식 문서 등록.
 * SUPER_ADMIN은 전체, 그 외 관리자는 자신이 만들었거나 협업자로 초대받은 위젯 키의 질문만 다룬다.
 */
@Injectable()
export class UnansweredQuestionsService {
  private readonly logger = new Logger(UnansweredQuestionsService.name);

  constructor(
    private readonly repo: UnansweredQuestionsRepository,
    private readonly organizationsRepo: OrganizationsRepository,
    private readonly uploadService: UploadService,
  ) {}

  async list(
    principal: AdminPrincipal,
    query: ListUnansweredQuestionsQueryDto,
  ): Promise<UnansweredQuestionsResponseDto> {
    const widgetKeyIds = await this.accessibleWidgetKeyIds(principal);
    const { rows, filteredTotal } = await this.repo.list({
      widgetKeyIds,
      widgetKeyId: query.widgetKeyId,
      page: query.page,
      size: query.size,
      query: query.query,
      status: query.status,
      sort: query.sort,
      order: query.order,
    });
    const totalPages =
      filteredTotal === 0 ? 0 : Math.ceil(filteredTotal / query.size);

    return {
      items: rows.map((row) => this.toDto(row)),
      page: {
        number: query.page,
        size: query.size,
        filteredTotal,
        totalPages,
        hasNext: query.page < totalPages,
        hasPrevious: query.page > 1 && filteredTotal > 0,
      },
    };
  }

  async getDetail(
    id: string,
    principal: AdminPrincipal,
  ): Promise<UnansweredQuestionDetailDto> {
    const record = await this.requireAccessible(id, principal);
    const lastAnswer = record.question.lastAnswerMessageId
      ? await this.repo.findLastAnswer(record.question.lastAnswerMessageId)
      : null;
    return { ...this.toDto(record), lastAnswer };
  }

  async updateStatus(
    id: string,
    status: UnansweredQuestionStatus,
    principal: AdminPrincipal,
  ): Promise<UnansweredQuestionDto> {
    await this.requireAccessible(id, principal);
    if (!(await this.repo.updateStatus(id, status, principal.uuid))) {
      throw new NotFoundException('Unanswered question not found');
    }
    return this.toDto(await this.reload(id));
  }

  async injectTextKnowledge(
    id: string,
    dto: InjectTextKnowledgeDto,
    principal: AdminPrincipal,
  ): Promise<UnansweredQuestionDto> {
    const record = await this.requireAccessible(id, principal);
    const title =
      dto.title?.trim() ||
      record.question.question.trim().slice(0, DEFAULT_TITLE_MAX_CHARS);
    const document = await this.uploadService.createTextDocument(
      title,
      dto.text,
      principal,
      dto.organizationId,
      dto.expiresAt,
    );
    return this.linkDocument(id, document, principal);
  }

  async injectPdfKnowledge(
    id: string,
    form: PdfUploadForm,
    principal: AdminPrincipal,
  ): Promise<UnansweredQuestionDto> {
    await this.requireAccessible(id, principal);
    const document = await this.uploadService.upload(
      form.file,
      form.filename,
      form.title,
      principal,
      form.organizationId,
      form.expiresAt,
    );
    return this.linkDocument(id, document, principal);
  }

  private async linkDocument(
    id: string,
    document: DocumentListItemDto,
    principal: AdminPrincipal,
  ): Promise<UnansweredQuestionDto> {
    if (!(await this.repo.linkDocument(id, document.id, principal.uuid))) {
      // 문서 등록 중 질문이 삭제된 경우(위젯 키 삭제 cascade). 문서는 문서 관리에서 계속 다룰 수 있다.
      this.logger.warn(
        `Unanswered question disappeared before linking document: question=${id} document=${document.id}`,
      );
      throw new NotFoundException('Unanswered question not found');
    }
    this.logger.log(
      `Knowledge document linked: question=${id} document=${document.id} source=${document.sourceType}`,
    );
    return this.toDto(await this.reload(id));
  }

  private async reload(id: string): Promise<UnansweredQuestionRecord> {
    const record = await this.repo.findById(id);
    if (!record) {
      throw new NotFoundException('Unanswered question not found');
    }
    return record;
  }

  /** null이면 전체 위젯 키 접근 가능(SUPER_ADMIN) */
  private async accessibleWidgetKeyIds(
    principal: AdminPrincipal,
  ): Promise<string[] | null> {
    if (await this.organizationsRepo.isCurrentSuperAdmin(principal)) {
      return null;
    }
    return this.repo.listAccessibleWidgetKeyIds(principal.uuid);
  }

  /** 접근 권한이 없는 질문은 존재 여부를 드러내지 않도록 404로 응답한다. */
  private async requireAccessible(
    id: string,
    principal: AdminPrincipal,
  ): Promise<UnansweredQuestionRecord> {
    const record = await this.repo.findById(id);
    if (!record) {
      throw new NotFoundException('Unanswered question not found');
    }
    const widgetKeyIds = await this.accessibleWidgetKeyIds(principal);
    if (widgetKeyIds && !widgetKeyIds.includes(record.question.widgetKeyId)) {
      throw new NotFoundException('Unanswered question not found');
    }
    return record;
  }

  private toDto(record: UnansweredQuestionRecord): UnansweredQuestionDto {
    const q = record.question;
    return {
      id: q.id,
      question: q.question,
      createdAt: q.createdAt,
      status: q.status,
      occurrenceCount: q.occurrenceCount,
      resolvedAt: q.resolvedAt,
      injectedKnowledge: this.toInjectedKnowledge(record),
      lastAskedAt: q.lastAskedAt,
      askedAgainAfterResolved:
        q.resolvedAt != null &&
        q.lastAskedAt.getTime() > q.resolvedAt.getTime(),
      widgetKeyId: q.widgetKeyId,
      widgetKeyName: record.widgetKeyName,
      language: q.language,
      lastSessionId: q.lastSessionId,
      resolvedByIdpUuid: q.resolvedByIdpUuid,
    };
  }

  private toInjectedKnowledge(
    record: UnansweredQuestionRecord,
  ): InjectedKnowledgeDto | null {
    const document = record.document;
    if (!document) return null;
    return {
      type: document.sourceType,
      injectedAt: record.question.resolvedAt ?? record.question.updatedAt,
      ...(document.sourceType === 'text'
        ? { text: document.sourceText ?? '' }
        : { fileName: `${document.resourceName}.pdf` }),
      documentId: document.id,
      documentTitle: document.title,
      documentStatus: document.status,
      documentActive: document.isActive,
    };
  }
}
