import { Controller, Delete, Get, HttpCode, Inject, Param, Post, Req, Res, UploadedFile, UseGuards, UseInterceptors, BadRequestException } from '@nestjs/common';
import { FileInterceptor } from '@nestjs/platform-express';
import { AccessTokenGuard, AuthenticatedRequest } from '../../modules/auth/access-token.guard';
import { FileResourceType, FILE_RESOURCE_TYPES, FileStorageService } from './file-storage.service';

@Controller('api/files')
@UseGuards(AccessTokenGuard)
export class FileController {
  constructor(@Inject(FileStorageService) private readonly files: FileStorageService) {}

  @Get(':id/download')
  async download(@Param('id') id: string, @Req() request: AuthenticatedRequest, @Res() response: any) {
    return this.sendFile(id, request, response, false, 'download');
  }

  @Get(':id/preview')
  async preview(@Param('id') id: string, @Req() request: AuthenticatedRequest, @Res() response: any) {
    return this.sendFile(id, request, response, true, 'read');
  }

  @Get(':resourceType/:resourceId')
  list(@Param('resourceType') resourceType: string, @Param('resourceId') resourceId: string, @Req() request: AuthenticatedRequest) {
    return this.files.list(this.parseType(resourceType), resourceId, request.auth.userId);
  }

  @Post(':resourceType/:resourceId')
  @UseInterceptors(FileInterceptor('file', { limits: { fileSize: 25 * 1024 * 1024 } }))
  upload(@Param('resourceType') resourceType: string, @Param('resourceId') resourceId: string, @UploadedFile() file: any, @Req() request: AuthenticatedRequest) {
    return this.files.upload(this.parseType(resourceType), resourceId, file, request.auth.userId);
  }

  @Delete(':id')
  @HttpCode(200)
  remove(@Param('id') id: string, @Req() request: AuthenticatedRequest) {
    return this.files.softDelete(id, request.auth.userId);
  }

  private async sendFile(id: string, request: AuthenticatedRequest, response: any, inline: boolean, operation: 'read' | 'download') {
    const file = await this.files.getForTransfer(id, request.auth.userId, operation);
    response.setHeader('Content-Type', file.mimeType);
    response.setHeader('Content-Length', String(file.sizeBytes));
    response.setHeader('Content-Disposition', `${inline ? 'inline' : 'attachment'}; filename*=UTF-8''${encodeURIComponent(file.originalName)}`);
    file.stream.pipe(response);
  }

  private parseType(value: string): FileResourceType {
    if ((FILE_RESOURCE_TYPES as readonly string[]).includes(value)) return value as FileResourceType;
    throw new BadRequestException('不支持的附件类型');
  }
}
