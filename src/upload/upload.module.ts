import { Module } from '@nestjs/common';
import {
  OrganizationDocumentsController,
  UploadController,
} from './upload.controller';
import { UploadService } from './upload.service';
import { AuthModule } from '../auth/auth.module';
import { DbModule } from '../db/db.module';
import { PdfProcessorModule } from '../pdf-processor/pdf-processor.module';
import { OrganizationsModule } from '../organizations/organizations.module';

@Module({
  imports: [AuthModule, DbModule, PdfProcessorModule, OrganizationsModule],
  controllers: [UploadController, OrganizationDocumentsController],
  providers: [UploadService],
})
export class UploadModule {}
