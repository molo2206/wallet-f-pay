// api-gateway/src/interceptors/logging.interceptor.ts
import {
  Injectable,
  NestInterceptor,
  ExecutionContext,
  CallHandler,
  Logger,
} from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';

@Injectable()
export class LoggingInterceptor implements NestInterceptor {
  private readonly logger = new Logger('HTTP');

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    const request = context.switchToHttp().getRequest();
    const { method, url, body, headers } = request;

    this.logger.log(`=== ${method} ${url} ===`);
    this.logger.log(
      `Headers: ${JSON.stringify({
        authorization: headers.authorization ? 'present' : 'missing',
        'content-type': headers['content-type'],
      })}`,
    );
    this.logger.log(`Body: ${JSON.stringify(body, null, 2)}`);

    const start = Date.now();

    return next.handle().pipe(
      tap(() => {
        const duration = Date.now() - start;
        this.logger.log(`Response time: ${duration}ms`);
      }),
    );
  }
}
