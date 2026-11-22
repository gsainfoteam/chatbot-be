import {
  BadRequestException,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { JwtService } from '@nestjs/jwt';
import { eq } from 'drizzle-orm';
import { randomUUID } from 'node:crypto';
import { DB_CONNECTION, type Database, sessions, widgetKeys } from '../db';
import {
  extractDomain,
  isDomainAllowed,
} from '../common/utils/domain-validator.util';

export const PLATFORM_SESSION_SECONDS = 1800;

@Injectable()
export class PlatformAuthService {
  constructor(
    @Inject(DB_CONNECTION) private readonly db: Database,
    private readonly config: ConfigService,
    private readonly jwt: JwtService,
  ) {}

  requireEnabled(): string {
    const enabled = this.config.get<boolean | string>('PLATFORM_CHAT_ENABLED');
    const key = this.config.get<string>('PLATFORM_WIDGET_KEY_ID');
    if (!(enabled === true || enabled === 'true') || !key) {
      throw new NotFoundException('Platform chat is not enabled');
    }
    return key;
  }

  async createSession(pageUrl: string, origin?: string) {
    const keyId = this.requireEnabled();
    let url: URL;
    try {
      url = new URL(pageUrl);
    } catch {
      throw new BadRequestException('Invalid pageUrl');
    }
    if (
      !['http:', 'https:'].includes(url.protocol) ||
      url.username ||
      url.password
    ) {
      throw new BadRequestException('Invalid pageUrl');
    }
    // Origin is a browser boundary, not proof of a user's identity.
    if (origin && origin !== url.origin)
      throw new ForbiddenException('Origin does not match pageUrl');
    const [key] = await this.db
      .select()
      .from(widgetKeys)
      .where(eq(widgetKeys.id, keyId))
      .limit(1);
    if (
      !key ||
      key.status !== 'ACTIVE' ||
      !isDomainAllowed(extractDomain(pageUrl), key.allowedDomains)
    ) {
      throw new ForbiddenException('Platform is unavailable for this domain');
    }
    const id = randomUUID();
    const token = await this.jwt.signAsync(
      { sessionId: id, widgetKeyId: keyId, channel: 'platform' },
      { expiresIn: PLATFORM_SESSION_SECONDS },
    );
    await this.db.insert(sessions).values({
      id,
      widgetKeyId: keyId,
      channel: 'platform',
      sessionToken: token,
      pageUrl,
      expiresAt: new Date(Date.now() + PLATFORM_SESSION_SECONDS * 1000),
    });
    return {
      sessionToken: token,
      sessionId: id,
      expiresIn: PLATFORM_SESSION_SECONDS,
    };
  }
}
