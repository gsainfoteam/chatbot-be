import { Injectable } from '@nestjs/common';
import { PassportStrategy } from '@nestjs/passport';
import { ExtractJwt, Strategy } from 'passport-jwt';
import { ConfigService } from '@nestjs/config';
import { AdminAccessTokenJwtPayload } from '../jwt/admin-jwt.payload';
import { AdminContext } from '../context/admin-context.entity';

@Injectable()
export class AdminJwtStrategy extends PassportStrategy(Strategy, 'admin-jwt') {
  constructor(configService: ConfigService) {
    super({
      jwtFromRequest: ExtractJwt.fromAuthHeaderAsBearerToken(),
      ignoreExpiration: false,
      secretOrKey: configService.getOrThrow<string>('JWT_SECRET'),
    });
  }

  validate(payload: AdminAccessTokenJwtPayload): AdminContext {
    return new AdminContext(
      payload.email,
      payload.uuid,
      payload.name,
      payload.role,
    );
  }
}
