import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { OrganizationsRepository } from '../organizations/organizations.repository';
import type { AdminPrincipal } from '../organizations/organization.types';
import {
  SuggestedQuestionsRepository,
  type AdminQuestionRecord,
  type UpdateSuggestedQuestionInput,
} from './suggested-questions.repository';
import {
  AdminSuggestedQuestionDto,
  AdminSuggestedQuestionsResponseDto,
  CreateSuggestedQuestionDto,
  ListAdminSuggestedQuestionsQueryDto,
  UpdateSuggestedQuestionDto,
} from './dto/suggested-question.dto';

const DEFAULT_NOTICE_URL_BASE = 'https://ziggle.gistory.me/notice/';

/**
 * 추천 질문 관리자 API.
 * SUPER_ADMIN은 전체, 그 외 관리자는 자신이 만들었거나 협업자로 초대받은 위젯 키만 다룬다.
 */
@Injectable()
export class SuggestedQuestionsAdminService {
  private readonly noticeUrlBase: string;

  constructor(
    private readonly repo: SuggestedQuestionsRepository,
    private readonly organizationsRepo: OrganizationsRepository,
    configService: ConfigService,
  ) {
    const base =
      configService.get<string>('ZIGGLE_NOTICE_URL_BASE')?.trim() ||
      DEFAULT_NOTICE_URL_BASE;
    this.noticeUrlBase = base.endsWith('/') ? base : `${base}/`;
  }

  async create(
    principal: AdminPrincipal,
    dto: CreateSuggestedQuestionDto,
  ): Promise<AdminSuggestedQuestionDto> {
    const widgetKeyName = await this.requireWidgetKeyAccess(
      principal,
      dto.widgetKeyId,
    );

    const now = new Date();
    const row = await this.repo.create({
      widgetKeyId: dto.widgetKeyId,
      question: dto.question,
      prompt: dto.prompt,
      source: 'ADMIN',
      // 관리자가 직접 등록한 질문은 이미 사람이 보고 넣은 것이므로 검수 단계를 거치지 않는다.
      status: 'APPROVED',
      createdByIdpUuid: principal.uuid,
      reviewedByIdpUuid: principal.uuid,
      reviewedAt: now,
    });
    if (!row) {
      throw new ConflictException(
        'A suggested question with the same text already exists for this widget key',
      );
    }
    return this.toDto({ question: row, widgetKeyName });
  }

  async list(
    principal: AdminPrincipal,
    query: ListAdminSuggestedQuestionsQueryDto,
  ): Promise<AdminSuggestedQuestionsResponseDto> {
    const widgetKeyIds = await this.accessibleWidgetKeyIds(principal);
    if (query.widgetKeyId) {
      await this.requireWidgetKeyAccess(principal, query.widgetKeyId);
    }

    const { rows, filteredTotal } = await this.repo.list({
      widgetKeyIds,
      widgetKeyId: query.widgetKeyId,
      page: query.page,
      size: query.size,
      status: query.status,
      source: query.source,
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
    principal: AdminPrincipal,
    id: string,
  ): Promise<AdminSuggestedQuestionDto> {
    return this.toDto(await this.requireAccessible(principal, id));
  }

  async update(
    principal: AdminPrincipal,
    id: string,
    dto: UpdateSuggestedQuestionDto,
  ): Promise<AdminSuggestedQuestionDto> {
    if (
      dto.status === undefined &&
      dto.question === undefined &&
      dto.prompt === undefined
    ) {
      throw new BadRequestException(
        'At least one of status, question or prompt must be provided',
      );
    }

    const record = await this.requireAccessible(principal, id);

    if (
      dto.question !== undefined &&
      (await this.repo.existsSameQuestion(
        record.question.widgetKeyId,
        dto.question,
        id,
      ))
    ) {
      throw new ConflictException(
        'A suggested question with the same text already exists for this widget key',
      );
    }

    const patch: UpdateSuggestedQuestionInput = {};
    if (dto.question !== undefined) patch.question = dto.question;
    if (dto.prompt !== undefined) patch.prompt = dto.prompt;
    // 상태를 건드릴 때만 검수 기록을 남긴다. 문구만 고친 것은 검수가 아니다.
    if (dto.status !== undefined) {
      patch.status = dto.status;
      patch.reviewedByIdpUuid = principal.uuid;
      patch.reviewedAt = new Date();
    }

    const row = await this.repo.update(id, patch);
    if (!row) {
      throw new NotFoundException('Suggested question not found');
    }
    return this.toDto({ question: row, widgetKeyName: record.widgetKeyName });
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
    principal: AdminPrincipal,
    id: string,
  ): Promise<AdminQuestionRecord> {
    const record = await this.repo.findById(id);
    if (!record) {
      throw new NotFoundException('Suggested question not found');
    }
    const widgetKeyIds = await this.accessibleWidgetKeyIds(principal);
    if (widgetKeyIds && !widgetKeyIds.includes(record.question.widgetKeyId)) {
      throw new NotFoundException('Suggested question not found');
    }
    return record;
  }

  /** 접근 가능한 위젯 키인지 확인하고 이름을 돌려준다. 아니면 404. */
  private async requireWidgetKeyAccess(
    principal: AdminPrincipal,
    widgetKeyId: string,
  ): Promise<string> {
    const name = await this.repo.findWidgetKeyName(widgetKeyId);
    if (!name) {
      throw new NotFoundException('Widget key not found');
    }
    const widgetKeyIds = await this.accessibleWidgetKeyIds(principal);
    if (widgetKeyIds && !widgetKeyIds.includes(widgetKeyId)) {
      throw new NotFoundException('Widget key not found');
    }
    return name;
  }

  private toDto(record: AdminQuestionRecord): AdminSuggestedQuestionDto {
    const q = record.question;
    return {
      id: q.id,
      widgetKeyId: q.widgetKeyId,
      widgetKeyName: record.widgetKeyName,
      question: q.question,
      prompt: q.prompt,
      source: q.source,
      status: q.status,
      noticeId: q.noticeId,
      noticeTitle: q.noticeTitle,
      noticeUrl:
        q.noticeId == null ? null : `${this.noticeUrlBase}${q.noticeId}`,
      reviewedByIdpUuid: q.reviewedByIdpUuid,
      reviewedAt: q.reviewedAt,
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
    };
  }
}
