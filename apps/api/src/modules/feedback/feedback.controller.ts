import { Body, Controller, Get, HttpCode, HttpStatus, Inject, Param, Patch, Post, Req, UseGuards } from '@nestjs/common';
import { AccessTokenGuard, AuthenticatedRequest } from '../auth/access-token.guard';
import { PermissionGuard } from '../auth/permission.guard';
import { RequirePermission } from '../auth/permission.decorator';
import { CreateFeedbackDto, UpdateFeedbackDto, UpdateFeedbackRoutingDto } from './dto/feedback.dto';
import { FeedbackService } from './feedback.service';

/**
 * 意见反馈：提交入口对所有登录用户开放；队列查看/处理才需要 feedback.manage。
 */
@Controller('api/feedback')
@UseGuards(AccessTokenGuard, PermissionGuard)
export class FeedbackController {
  constructor(@Inject(FeedbackService) private readonly feedbackService: FeedbackService) {}

  @Post()
  @HttpCode(HttpStatus.CREATED)
  create(@Body() input: CreateFeedbackDto, @Req() request: AuthenticatedRequest) {
    return this.feedbackService.create(input, request.auth.userId);
  }

  @Get()
  @RequirePermission('feedback.manage')
  list(@Req() request: AuthenticatedRequest) {
    return this.feedbackService.list(request.auth.userId);
  }

  @Patch(':id')
  @HttpCode(HttpStatus.OK)
  @RequirePermission('feedback.manage')
  update(@Param('id') id: string, @Body() input: UpdateFeedbackDto, @Req() request: AuthenticatedRequest) {
    return this.feedbackService.update(id, input, request.auth.userId);
  }
}

/** 系统 B：配置反馈接收部门。 */
@Controller('api/admin/feedback-routing')
@UseGuards(AccessTokenGuard, PermissionGuard)
@RequirePermission('system.admin.access')
export class FeedbackRoutingController {
  constructor(@Inject(FeedbackService) private readonly feedbackService: FeedbackService) {}

  @Get()
  list() {
    return this.feedbackService.listRouting();
  }

  @Post()
  @HttpCode(HttpStatus.OK)
  update(@Body() input: UpdateFeedbackRoutingDto, @Req() request: AuthenticatedRequest) {
    return this.feedbackService.updateRouting(input, request.auth.userId);
  }
}
