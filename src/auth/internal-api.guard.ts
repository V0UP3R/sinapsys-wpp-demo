import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
} from '@nestjs/common';
import { Request } from 'express';

declare module 'express' {
  export interface Request {
    user?: {
      userId: string;
    };
  }
}
import * as CryptoJS from 'crypto-js';
import * as dotenv from 'dotenv';

dotenv.config();

@Injectable()
export class InternalApiGuard implements CanActivate {
  private readonly JWT_SECRET = process.env.JWT_SECRET!;
  private readonly INTERNAL_KEY = process.env.INTERNAL_KEY!;

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const request = context.switchToHttp().getRequest<Request>();

    // const accessToken = this.extractToken(request);
    // if (!accessToken) throw new UnauthorizedException('Access token ausente');

    // const decoded = this.decodeAccessToken(accessToken);
    // if (!decoded || typeof decoded !== 'object' || !decoded.sub)
    //   throw new UnauthorizedException('Token inválido');

    // request.user = {
    //   userId: decoded.sub,
    // };

    const encryptedDate = request.headers['x-encrypted-date'];
    if (!encryptedDate || typeof encryptedDate !== 'string') {
      throw new UnauthorizedException('Cabeçalho x-encrypted-date ausente');
    }

    const decryptedDate = this.decryptDate(encryptedDate);
    if (!decryptedDate) {
      throw new UnauthorizedException('Token inválido');
    }

    const now = new Date();
    const diffMinutes = (now.getTime() - decryptedDate.getTime()) / 1000 / 60;
    if (diffMinutes > 5) {
      throw new UnauthorizedException('Token expirado');
    }

    return true;
  }

  // private extractToken(request: Request): string | null {
  //   const authHeader = request.headers.authorization;
  //   if (!authHeader) return null;

  //   const [type, token] = authHeader.split(' ');
  //   return type === 'Bearer' && token ? token : null;
  // }

  // private decodeAccessToken(token: string) {
  //   try {
  //     return jwt.verify(token, this.JWT_SECRET, {
  //       ignoreExpiration: true,
  //     }) as { sub: string };
  //   } catch {
  //     return null;
  //   }
  // }

  private decryptDate(encrypted: string): Date | null {
    try {
      const bytes = CryptoJS.AES.decrypt(encrypted, this.INTERNAL_KEY);
      const decrypted = bytes.toString(CryptoJS.enc.Utf8);
      const date = new Date(decrypted);
      return isNaN(date.getTime()) ? null : date;
    } catch {
      return null;
    }
  }
}