import { Module } from '@nestjs/common';
import { AuthModule } from '../auth/auth.module';
import { DbModule } from '../db/db.module';
import { OrganizationAccessService } from './organization-access.service';
import { OrganizationsController } from './organizations.controller';
import { OrganizationsRepository } from './organizations.repository';
import { OrganizationsService } from './organizations.service';

@Module({
  imports: [DbModule, AuthModule],
  controllers: [OrganizationsController],
  providers: [
    OrganizationsRepository,
    OrganizationAccessService,
    OrganizationsService,
  ],
  exports: [OrganizationsRepository, OrganizationAccessService],
})
export class OrganizationsModule {}
