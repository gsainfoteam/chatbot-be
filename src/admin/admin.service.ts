import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
  ForbiddenException,
} from '@nestjs/common';
import { DB_CONNECTION, type Database, widgetKeys } from '../db';
import { and, eq, ne } from 'drizzle-orm';
import { generateWidgetKey } from '../common/utils/widget-key-generator.util';
import { CreateWidgetKeyDto } from '../common/dto/create-widget-key.dto';
import { RegisterDomainsDto } from '../common/dto/register-domains.dto';
import { WidgetKeyDto, WidgetKeyStatus } from '../common/dto/widget-key.dto';

@Injectable()
export class AdminService {
  constructor(@Inject(DB_CONNECTION) private db: Database) {}

  async getAllWidgetKeys(adminUuid: string): Promise<WidgetKeyDto[]> {
    const keys = await this.db
      .select()
      .from(widgetKeys)
      .where(
        and(
          eq(widgetKeys.createdByIdpUuid, adminUuid),
          ne(widgetKeys.status, 'REVOKED'),
        ),
      );

    return keys.map((key) => ({
      id: key.id,
      name: key.name,
      secretKey: key.secretKey,
      status: key.status as WidgetKeyStatus,
      allowedDomains: key.allowedDomains,
      createdAt: key.createdAt,
    }));
  }

  async createWidgetKey(
    dto: CreateWidgetKeyDto,
    adminUuid: string,
  ): Promise<WidgetKeyDto> {
    // 고유한 secretKey 생성 (중복 방지)
    let secretKey: string;
    let attempts = 0;
    const maxAttempts = 10;

    while (attempts < maxAttempts) {
      secretKey = generateWidgetKey();

      // 중복 확인
      const [existing] = await this.db
        .select()
        .from(widgetKeys)
        .where(eq(widgetKeys.secretKey, secretKey))
        .limit(1);

      if (!existing) {
        break;
      }

      attempts++;
    }

    if (attempts >= maxAttempts) {
      throw new BadRequestException('Failed to generate unique widget key');
    }

    // DB에 저장 (도메인 없이)
    const [newKey] = await this.db
      .insert(widgetKeys)
      .values({
        name: dto.name,
        secretKey: secretKey!,
        status: 'ACTIVE',
        allowedDomains: [],
        createdByIdpUuid: adminUuid,
      })
      .returning();

    return {
      id: newKey.id,
      name: newKey.name,
      secretKey: newKey.secretKey,
      status: newKey.status as WidgetKeyStatus,
      allowedDomains: newKey.allowedDomains,
      createdAt: newKey.createdAt,
    };
  }

  async registerDomains(
    widgetKeyId: string,
    dto: RegisterDomainsDto,
    adminUuid: string,
  ): Promise<WidgetKeyDto> {
    // 키 존재 여부 및 소유자 확인
    const [existingKey] = await this.db
      .select()
      .from(widgetKeys)
      .where(eq(widgetKeys.id, widgetKeyId))
      .limit(1);

    if (!existingKey) {
      throw new NotFoundException('Widget key not found');
    }

    if (existingKey.createdByIdpUuid !== adminUuid) {
      throw new ForbiddenException(
        'You do not have permission to modify this widget key',
      );
    }

    // 도메인에 프로토콜이 포함되어 있는지 검증
    if (dto.domain.includes('://')) {
      throw new BadRequestException(
        'Domain should not include protocol (https://). Please remove the protocol.',
      );
    }

    // 기존 도메인 목록 가져오기
    const existingDomains = existingKey.allowedDomains || [];

    // 이미 등록된 도메인이면 에러 반환
    if (existingDomains.includes(dto.domain)) {
      throw new BadRequestException('Domain already exists');
    }

    // 도메인 추가
    const updatedDomains = [...existingDomains, dto.domain];

    // DB 업데이트
    const [updatedKey] = await this.db
      .update(widgetKeys)
      .set({
        allowedDomains: updatedDomains,
        updatedAt: new Date(),
      })
      .where(eq(widgetKeys.id, widgetKeyId))
      .returning();

    return {
      id: updatedKey.id,
      name: updatedKey.name,
      secretKey: updatedKey.secretKey,
      status: updatedKey.status as WidgetKeyStatus,
      allowedDomains: updatedKey.allowedDomains,
      createdAt: updatedKey.createdAt,
    };
  }

  async revokeWidgetKey(
    widgetKeyId: string,
    adminUuid: string,
  ): Promise<WidgetKeyDto> {
    // 키 존재 여부 및 소유자 확인
    const [existingKey] = await this.db
      .select()
      .from(widgetKeys)
      .where(eq(widgetKeys.id, widgetKeyId))
      .limit(1);

    if (!existingKey) {
      throw new NotFoundException('Widget key not found');
    }

    if (existingKey.createdByIdpUuid !== adminUuid) {
      throw new ForbiddenException(
        'You do not have permission to revoke this widget key',
      );
    }

    // status를 REVOKED로 변경
    const [updatedKey] = await this.db
      .update(widgetKeys)
      .set({
        status: 'REVOKED',
        updatedAt: new Date(),
      })
      .where(eq(widgetKeys.id, widgetKeyId))
      .returning();

    return {
      id: updatedKey.id,
      name: updatedKey.name,
      secretKey: updatedKey.secretKey,
      status: updatedKey.status as WidgetKeyStatus,
      allowedDomains: updatedKey.allowedDomains,
      createdAt: updatedKey.createdAt,
    };
  }

  async removeDomain(
    widgetKeyId: string,
    domain: string,
    adminUuid: string,
  ): Promise<WidgetKeyDto> {
    // 키 존재 여부 및 소유자 확인
    const [existingKey] = await this.db
      .select()
      .from(widgetKeys)
      .where(eq(widgetKeys.id, widgetKeyId))
      .limit(1);

    if (!existingKey) {
      throw new NotFoundException('Widget key not found');
    }

    if (existingKey.createdByIdpUuid !== adminUuid) {
      throw new ForbiddenException(
        'You do not have permission to modify this widget key',
      );
    }

    // 기존 도메인 목록 가져오기
    const existingDomains = existingKey.allowedDomains || [];

    // 도메인이 존재하지 않으면 에러 반환
    if (!existingDomains.includes(domain)) {
      throw new NotFoundException('Domain not found');
    }

    // 도메인 제거
    const updatedDomains = existingDomains.filter((d) => d !== domain);

    // DB 업데이트
    const [updatedKey] = await this.db
      .update(widgetKeys)
      .set({
        allowedDomains: updatedDomains,
        updatedAt: new Date(),
      })
      .where(eq(widgetKeys.id, widgetKeyId))
      .returning();

    return {
      id: updatedKey.id,
      name: updatedKey.name,
      secretKey: updatedKey.secretKey,
      status: updatedKey.status as WidgetKeyStatus,
      allowedDomains: updatedKey.allowedDomains,
      createdAt: updatedKey.createdAt,
    };
  }
}
