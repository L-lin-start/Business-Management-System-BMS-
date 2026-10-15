import { Module } from '@nestjs/common';
import { FileController } from './file.controller';
import { FileStorageService } from './file-storage.service';

@Module({ controllers: [FileController], providers: [FileStorageService], exports: [FileStorageService] })
export class FileModule {}
