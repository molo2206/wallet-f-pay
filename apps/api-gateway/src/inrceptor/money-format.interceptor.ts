// apps/api-gateway/src/inrceptor/money-format.interceptor.ts
import { BadRequestException, CallHandler, ExecutionContext, Injectable, NestInterceptor } from '@nestjs/common';
import { Observable } from 'rxjs';
import { map } from 'rxjs/operators';
import { hasAtMost3Decimals, isMoneyKey, round3, roundMoneyFields } from '@app/common';
import { isFinancialRoute } from './idempotency.util';

/**
 * ✅ MONTANTS À 3 DÉCIMALES DANS LES RÉPONSES API
 *  - Chaque montant (amount, balance, fee, total…, jamais les taux / pourcentages) est arrondi à 3 décimales :
 *    supprime le bruit des flottants (10.299999999 → 10.3).
 *  - MONEY_FORMATTED_FIELDS=true ajoute en plus « <champ>Formatted: "10.300" » (texte toujours à 3 décimales),
 *    sans modifier les champs existants (compatibilité totale).
 *  - En-tête de requête `X-Money-Format: 3` : active les champs « Formatted » pour cette requête seulement.
 *  - Saisie (routes financières) : montant à plus de 3 décimales → arrondi à 3 décimales (défaut),
 *    ou refusé en 400 si MONEY_INPUT_STRICT=true.
 *  - MONEY_ROUNDING_ENABLED=false désactive tout.
 */
@Injectable()
export class MoneyFormatInterceptor implements NestInterceptor {
  intercept(context: ExecutionContext, next: CallHandler): Observable<any> {
    if (context.getType() !== 'http') return next.handle();
    if (String(process.env.MONEY_ROUNDING_ENABLED ?? 'true').toLowerCase() === 'false') return next.handle();
    const req = context.switchToHttp().getRequest();
    const method = String(req?.method || '').toUpperCase();
    if (['POST', 'PUT', 'PATCH'].includes(method) && req?.body && typeof req.body === 'object') {
      const path = String(req.path || req.url || '').split('?')[0];
      if (isFinancialRoute(path)) this.normalizeInput(req.body);
    }
    const formatted =
      String(process.env.MONEY_FORMATTED_FIELDS ?? 'false').toLowerCase() === 'true' ||
      String(req?.headers?.['x-money-format'] ?? '') === '3';
    return next.handle().pipe(
      map((body) => {
        if (!body || typeof body !== 'object' || Buffer.isBuffer(body)) return body;
        try {
          return roundMoneyFields(body, formatted);
        } catch {
          return body;
        }
      }),
    );
  }

  /** Montants saisis : au plus 3 décimales (premier niveau du corps) */
  private normalizeInput(body: any) {
    const strict = String(process.env.MONEY_INPUT_STRICT ?? 'false').toLowerCase() === 'true';
    for (const [k, v] of Object.entries(body)) {
      if (!isMoneyKey(k)) continue;
      if (typeof v !== 'number' && !(typeof v === 'string' && /^-?\d+([.,]\d+)?$/.test(v.trim()))) continue;
      if (hasAtMost3Decimals(v as any)) continue;
      if (strict) {
        throw new BadRequestException({
          statusCode: 400,
          code: 'AMOUNT_TOO_MANY_DECIMALS',
          message: `Le champ « ${k} » accepte au maximum 3 chiffres après la virgule.`,
        });
      }
      body[k] = typeof v === 'number' ? round3(v) : round3(v).toFixed(3);
    }
  }
}
