import { ExecutionContext, Injectable } from '@nestjs/common';
import { AuthGuard } from '@nestjs/passport';
import { InternalApiGuard } from './internal-api.guard';
import { Reflector } from '@nestjs/core';
import { IS_PUBLIC_KEY } from './decorators/public.decorator';

@Injectable()
export class JwtAuthGuard extends AuthGuard('jwt') {

  private internalGuard = new InternalApiGuard();
  
  constructor(private reflector: Reflector) {
    super();
  }

  canActivate(context: ExecutionContext) {

    const req = context.switchToHttp().getRequest();
    
    if (req.method === 'OPTIONS') {
      return true;
    }

    const isPublic = this.reflector.getAllAndOverride<boolean>(IS_PUBLIC_KEY, [
      context.getHandler(),
      context.getClass(),
    ]);

    if (isPublic) {
      return true;
    }

    if (this.internalGuard.canActivate(context)) {
      return true;
    }

    return super.canActivate(context);
  }
}