import { Module } from '@nestjs/common';
import { InfoteamIdpService } from './infoteam-idp.service';
import { HttpModule } from '@nestjs/axios';
import { ConfigModule } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';

@Module({
  imports: [
    HttpModule.register({
      timeout: 10000, // 10초 타임아웃
      maxRedirects: 5,
    }),
    ConfigModule,
    JwtModule,
  ],
  providers: [InfoteamIdpService],
  exports: [InfoteamIdpService],
})
export class InfoteamIdpModule {}
