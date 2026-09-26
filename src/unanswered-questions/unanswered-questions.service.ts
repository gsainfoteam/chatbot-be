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
  CreateTextKnowledgeDto,
  ListUnansweredQuestionsQueryDto,
  RegisteredKnowledgeDocumentDto,
  UnansweredQuestionDetailDto,
  UnansweredQuestionDto,
  UnansweredQuestionsResponseDto,
} from './dto/unanswered-question.dto';

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

  async registerTextDocument(
    id: string,
    dto: CreateTextKnowledgeDto,
    principal: AdminPrincipal,
  ): Promise<RegisteredKnowledgeDocumentDto> {
    await this.requireAccessible(id, principal);
    const document = await this.uploadService.createTextDocument(
      dto.title,
      dto.content,
      principal,
      dto.organizationId,
      dto.expiresAt,
    );
    return this.linkDocument(id, document, principal);
  }

  async registerPdfDocument(
    id: string,
    form: PdfUploadForm,
    principal: AdminPrincipal,
  ): Promise<RegisteredKnowledgeDocumentDto> {
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
  ): Promise<RegisteredKnowledgeDocumentDto> {
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
    return { question: this.toDto(await this.reload(id)), document };
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
      widgetKeyId: q.widgetKeyId,
      widgetKeyName: record.widgetKeyName,
      question: q.question,
      language: q.language,
      askCount: q.askCount,
      status: q.status,
      lastSessionId: q.lastSessionId,
      firstAskedAt: q.firstAskedAt,
      lastAskedAt: q.lastAskedAt,
      resolvedAt: q.resolvedAt,
      resolvedByIdpUuid: q.resolvedByIdpUuid,
      askedAgainAfterResolved:
        q.resolvedAt != null &&
        q.lastAskedAt.getTime() > q.resolvedAt.getTime(),
      document: record.document,
    };
  }
}
