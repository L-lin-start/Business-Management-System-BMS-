import { SetMetadata } from '@nestjs/common';

export const PERMISSION_CODE_KEY = 'permissionCode';
export const RequirePermission = (code: string) => SetMetadata(PERMISSION_CODE_KEY, code);
