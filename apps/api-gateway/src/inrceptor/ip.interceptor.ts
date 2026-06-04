import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
} from '@nestjs/common';
import { Observable } from 'rxjs';

@Injectable()
export class IpInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();

    let ip =
      request.headers['x-forwarded-for'] ||
      request.headers['x-real-ip'] ||
      request.socket?.remoteAddress ||
      request.connection?.remoteAddress ||
      request.ip;

    // Si plusieurs IP (proxy), prendre la première
    if (typeof ip === 'string' && ip.includes(',')) {
      ip = ip.split(',')[0].trim();
    }

    // Nettoyage IPv6
    if (ip && ip.startsWith('::ffff:')) {
      ip = ip.replace('::ffff:', '');
    }

    request.clientIp = ip || 'unknown';
    console.log('[IpInterceptor] IP =', request.clientIp); // ← log
    return next.handle();
  }
}
