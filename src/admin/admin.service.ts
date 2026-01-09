import {
  Injectable,
  Inject,
  NotFoundException,
  BadRequestException,
} from '@nestjs/common';
import { DB_CONNECTION, type Database, widgetKeys } from '../db';
import { eq } from 'drizzle-orm';
import { generateWidgetKey } from '../common/utils/widget-key-generator.util';
import { CreateWidgetKeyDto } from '../common/dto/create-widget-key.dto';
import { WidgetKeyDto, WidgetKeyStatus } from '../common/dto/widget-key.dto';

@Injectable()
export class AdminService {
  constructor(@Inject(DB_CONNECTION) private db: Database) {}

  async getAllWidgetKeys(): Promise<WidgetKeyDto[]> {
    const keys = await this.db.select().from(widgetKeys);

    return keys.map((key) => ({
      id: key.id,
      name: key.name,
      secretKey: key.secretKey,
      status: key.status as WidgetKeyStatus,
      allowedDomains: key.allowedDomains,
      createdAt: key.createdAt,
    }));
  }

  async createWidgetKey(dto: CreateWidgetKeyDto): Promise<WidgetKeyDto> {
    // 도메인에 https:// 가 포함되어 있는지 검증
    const invalidDomains = dto.allowedDomains.filter(
      (domain) =>
        domain.includes('://') ||
        domain.startsWith('http') ||
        domain.startsWith('https'),
    );

    if (invalidDomains.length > 0) {
      throw new BadRequestException(
        `Domains should not include protocol (https://). Invalid domains: ${invalidDomains.join(', ')}`,
      );
    }

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

    // DB에 저장
    const [newKey] = await this.db
      .insert(widgetKeys)
      .values({
        name: dto.name,
        secretKey: secretKey!,
        status: 'ACTIVE',
        allowedDomains: dto.allowedDomains,
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

  async revokeWidgetKey(widgetKeyId: string): Promise<WidgetKeyDto> {
    // 키 존재 여부 확인
    const [existingKey] = await this.db
      .select()
      .from(widgetKeys)
      .where(eq(widgetKeys.id, widgetKeyId))
      .limit(1);

    if (!existingKey) {
      throw new NotFoundException('Widget key not found');
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
}
