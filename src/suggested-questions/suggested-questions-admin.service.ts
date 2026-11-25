import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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
 * 기한 문자열을 Date로. null은 무기한이다. 지난 시각은 받지 않는다.
 * 문서 기한(upload.service parseExpiresAt)과 같은 규칙이다.
 */
export function parseExpiresAt(raw: string | null): Date | null {
  if (raw === null) return null;
  const parsed = new Date(raw);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException(
      'expiresAt must be a valid ISO-8601 datetime',
    );
  }
  if (parsed.getTime() <= Date.now()) {
    throw new BadRequestException('expiresAt must be in the future');
  }
  return parsed;
}

/**
 * 추천 질문 관리자 API.
 *
 * 호출자는 컨트롤러의 SuperAdminGuard를 통과한 SUPER_ADMIN뿐이라 위젯 키 범위를 따로
 * 좁히지 않는다. 위젯 키 발급은 서비스가 챗봇을 자기 페이지에 붙이기 위한 것이고,
 * 질문과 프롬프트는 챗봇이 학생에게 무엇을 말할지 정한다. 같은 권한으로 묶지 않는다.
 */
@Injectable()
export class SuggestedQuestionsAdminService {
  private readonly noticeUrlBase: string;

  constructor(
    private readonly repo: SuggestedQuestionsRepository,
    configService: ConfigService,
  ) {
    const base =
      configService.get<string>('ZIGGLE_NOTICE_URL_BASE')?.trim() ||
      DEFAULT_NOTICE_URL_BASE;
    this.noticeUrlBase = base.endsWith('/') ? base : `${base}/`;
  }

  async create(
    adminIdpUuid: string,
    dto: CreateSuggestedQuestionDto,
  ): Promise<AdminSuggestedQuestionDto> {
    const expiresAt = parseExpiresAt(dto.expiresAt);
    const widgetKeyName = await this.requireWidgetKey(dto.widgetKeyId);

    const now = new Date();
    const row = await this.repo.create({
      widgetKeyId: dto.widgetKeyId,
      question: dto.question,
      // 관리자 질문은 대개 학교 문서에 있는 내용이라 질문을 그대로 보내면 된다.
      prompt: dto.prompt ?? null,
      source: 'ADMIN',
      // 사람이 보고 넣은 질문이므로 검수 단계를 거치지 않는다.
      // 대신 승인과 같으므로 기한도 이 자리에서 정한다(무기한이면 null).
      status: 'APPROVED',
      createdByIdpUuid: adminIdpUuid,
      reviewedByIdpUuid: adminIdpUuid,
      reviewedAt: now,
      expiresAt,
    });
    if (!row) {
      throw new ConflictException(
        'A suggested question with the same text already exists for this widget key',
      );
    }
    return this.toDto({ question: row, widgetKeyName });
  }

  async list(
    query: ListAdminSuggestedQuestionsQueryDto,
  ): Promise<AdminSuggestedQuestionsResponseDto> {
    if (query.widgetKeyId) {
      await this.requireWidgetKey(query.widgetKeyId);
    }

    const { rows, filteredTotal } = await this.repo.list({
      widgetKeyId: query.widgetKeyId,
      page: query.page,
      size: query.size,
      status: query.status,
      source: query.source,
      expiry: query.expiry,
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

  async getDetail(id: string): Promise<AdminSuggestedQuestionDto> {
    return this.toDto(await this.requireQuestion(id));
  }

  async update(
    adminIdpUuid: string,
    id: string,
    dto: UpdateSuggestedQuestionDto,
  ): Promise<AdminSuggestedQuestionDto> {
    if (
      dto.status === undefined &&
      dto.question === undefined &&
      dto.prompt === undefined &&
      dto.expiresAt === undefined
    ) {
      throw new BadRequestException(
        'At least one of status, question, prompt or expiresAt must be provided',
      );
    }
    // 승인은 첫 화면에 띄우는 결정이라, 언제까지 띄울지도 그 자리에서 정하게 한다.
    // 무기한도 null로 명시해야 한다. 빠뜨린 채 승인되면 영영 내려가지 않는다.
    if (dto.status === 'APPROVED' && dto.expiresAt === undefined) {
      throw new BadRequestException(
        'expiresAt is required when approving (use null for no expiry)',
      );
    }
    const expiresAt =
      dto.expiresAt === undefined ? undefined : parseExpiresAt(dto.expiresAt);

    const record = await this.requireQuestion(id);

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
    if (expiresAt !== undefined) patch.expiresAt = expiresAt;
    // 상태를 건드릴 때만 검수 기록을 남긴다. 문구만 고친 것은 검수가 아니다.
    if (dto.status !== undefined) {
      patch.status = dto.status;
      patch.reviewedByIdpUuid = adminIdpUuid;
      patch.reviewedAt = new Date();
    }

    const row = await this.repo.update(id, patch);
    if (!row) {
      throw new NotFoundException('Suggested question not found');
    }
    return this.toDto({ question: row, widgetKeyName: record.widgetKeyName });
  }

  private async requireQuestion(id: string): Promise<AdminQuestionRecord> {
    const record = await this.repo.findById(id);
    if (!record) {
      throw new NotFoundException('Suggested question not found');
    }
    return record;
  }

  /** 위젯 키가 실제로 있는지 확인하고 이름을 돌려준다. */
  private async requireWidgetKey(widgetKeyId: string): Promise<string> {
    const name = await this.repo.findWidgetKeyName(widgetKeyId);
    if (!name) {
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
      expiresAt: q.expiresAt,
      expired: q.expiresAt != null && q.expiresAt.getTime() <= Date.now(),
      createdAt: q.createdAt,
      updatedAt: q.updatedAt,
    };
  }
}
