import { Module } from '@nestjs/common';
import { HttpModule } from '@nestjs/axios';
import { UploadController } from './upload.controller';
import { UploadService } from './upload.service';
import { AuthModule } from '../auth/auth.module';
import { DbModule } from '../db/db.module';

@Module({
  imports: [HttpModule, AuthModule, DbModule],
  controllers: [UploadController],
  providers: [UploadService],
})
export class UploadModule {}
