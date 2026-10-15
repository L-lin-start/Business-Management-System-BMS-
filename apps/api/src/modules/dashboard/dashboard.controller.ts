import { Controller, Get, Inject, Req, UseGuards } from '@nestjs/common';
import { DataScope } from '@prisma/client';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { PermissionGuard } from '../auth/permission.guard';
import { DashboardService } from './dashboard.service';

@Controller('api/dashboard')
@UseGuards(AccessTokenGuard, PermissionGuard)
export class DashboardController {
  constructor(@Inject(DashboardService) private readonly dashboardService: DashboardService) {}

  @Get('overview')
  @RequirePermission('customer.read')
  overview(@Req() request: AuthenticatedRequest) {
    return this.dashboardService.overview(request.auth.userId, (request.auth.permissionScope ?? 'NONE') as DataScope);
  }
}
