import { Module } from '@nestjs/common';
import { AdminController } from './admin.controller';
import { AdminService } from './admin.service';
import { AuthModule } from '../auth/auth.module';
import { UsageModule } from '../usage/usage.module';

@Module({
  imports: [AuthModule, UsageModule],
  controllers: [AdminController],
  providers: [AdminService],
})
export class AdminModule {}
