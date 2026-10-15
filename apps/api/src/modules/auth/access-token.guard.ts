import {
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { JwtService } from '@nestjs/jwt';

export type AuthenticatedRequest = {
  headers: {
    authorization?: string;
  };
  auth: {
    userId: string;
    username: string;
    roles: string[];
    permissionScope?: 'ALL' | 'DEPARTMENT' | 'DEPARTMENT_AND_DESCENDANTS' | 'SELF' | 'RELATED' | 'NONE';
  };
};

@Injectable()
export class AccessTokenGuard implements CanActivate {
  constructor(@Inject(JwtService) private readonly jwtService: JwtService) {}

  async canActivate(context: ExecutionContext) {
    const request = context.switchToHttp().getRequest<AuthenticatedRequest>();
    const authorization = request.headers.authorization;

    if (!authorization?.startsWith('Bearer ')) {
      throw new UnauthorizedException('登录状态已失效');
    }

    try {
      const payload = await this.jwtService.verifyAsync<{
        sub: string;
        username: string;
        roles: string[];
      }>(authorization.slice(7));

      request.auth = {
        userId: payload.sub,
        username: payload.username,
        roles: payload.roles,
      };
      return true;
    } catch {
      throw new UnauthorizedException('登录状态已失效');
    }
  }
}
