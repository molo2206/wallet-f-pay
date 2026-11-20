import { CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { tap } from 'rxjs/operators';
import { AccountingService } from './accounting.service';

/**
 * ✅ Comptabilisation DIRECTE (pas de job planifié).
 * Après CHAQUE message traité par le wallet-service, on passe immédiatement au
 * journal les transactions non encore comptabilisées (moteur idempotent
 * `accounting.postNow()`). Les écritures apparaissent donc en quasi temps réel,
 * juste après l'opération, sans attendre un cron.
 *
 * Fire-and-forget : une erreur comptable ne doit JAMAIS faire échouer l'opération
 * financière (le lock interne de la projection évite aussi les exécutions simultanées).
 */
@Injectable()
export class AccountingPostInterceptor implements NestInterceptor {
  constructor(private readonly accounting: AccountingService) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    return next.handle().pipe(
      tap(() => {
        // on ne bloque pas la réponse : la passation se fait juste après, en arrière-plan
        setImmediate(() => {
          this.accounting.postNow().catch(() => undefined);
        });
      }),
    );
  }
}
