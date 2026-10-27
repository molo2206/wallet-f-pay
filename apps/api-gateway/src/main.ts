// api-gateway/src/main.ts
import { NestFactory } from '@nestjs/core';
import { Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';

dotenv.config();

/** Sites autorisés (liste fixe) — on peut en ajouter via CORS_ORIGINS=https://a.com,https://b.com */
const STATIC_ORIGINS = [
  'https://f-pay-eight.vercel.app',
  'https://favorpay.vercel.app',
  'https://admin.f-pay.app',
  'https://f-pay.app',
  'https://www.f-pay.app',
  'https://api-prod.f-pay.app',
  'https://www.favorhelp.com',
  'https://favorhelp.com',
  'http://localhost:3000',
  'http://localhost:3001',
  'http://localhost:4200',
  'http://localhost:5173',
];

/** Domaines dont TOUS les sous-domaines sont autorisés (https uniquement) */
const TRUSTED_DOMAINS = ['f-pay.app', 'favorhelp.com'];

/** Prévisualisations Vercel des projets F-Pay / FavorPay (ex. https://f-pay-git-main-xxx.vercel.app) */
const VERCEL_PREVIEW = /^https:\/\/(f-pay|favorpay)[a-z0-9-]*\.vercel\.app$/i;

function allowedOrigins(): Set<string> {
  const extra = String(process.env.CORS_ORIGINS || '')
    .split(',')
    .map((o) => o.trim().replace(/\/+$/, ''))
    .filter(Boolean);
  return new Set([...STATIC_ORIGINS, ...extra]);
}

function isAllowed(origin: string, list: Set<string>): boolean {
  const clean = origin.replace(/\/+$/, '');
  if (list.has(clean)) return true;
  if (VERCEL_PREVIEW.test(clean)) return true;
  try {
    const url = new URL(clean);
    if (url.protocol === 'https:' && TRUSTED_DOMAINS.some((d) => url.hostname === d || url.hostname.endsWith(`.${d}`))) {
      return true;
    }
    // Développement local (n'importe quel port)
    if (process.env.NODE_ENV !== 'production' && ['localhost', '127.0.0.1'].includes(url.hostname)) return true;
  } catch {
    return false;
  }
  return false;
}

async function bootstrap() {
  const app = await NestFactory.create(AppModule);
  const logger = new Logger('Bootstrap');
  const origins = allowedOrigins();

  // Derrière nginx / un load balancer : IP et protocole réels du client
  const http: any = app.getHttpAdapter().getInstance();
  if (typeof http?.set === 'function') http.set('trust proxy', 1);

  app.enableCors({
    origin: (origin, callback) => {
      // Applis mobiles, Postman, serveur à serveur (pas d'en-tête Origin)
      if (!origin) return callback(null, true);
      if (isAllowed(origin, origins) || process.env.NODE_ENV === 'development') return callback(null, true);
      // ✅ Refus « propre » : pas d'exception (sinon réponse 500 sans en-têtes CORS)
      logger.warn(`CORS refusé : ${origin} (ajoutez-le à CORS_ORIGINS si besoin)`);
      return callback(null, false);
    },
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    // ✅ Pas de liste fixe : on accepte les en-têtes demandés par le navigateur
    //    (Authorization, lang, x-lang, x-platform, Accept-Language, Cache-Control, Idempotency-Key…)
    allowedHeaders: undefined,
    exposedHeaders: ['Content-Disposition', 'Content-Length', 'X-Request-Id'],
    credentials: true,
    maxAge: 86400,
    preflightContinue: false,
    optionsSuccessStatus: 204,
  });

  app.enableShutdownHooks();

  const port = Number(process.env.API_GATEWAY_PORT || 3000);
  const host = process.env.API_GATEWAY_HOST || '0.0.0.0';
  await app.listen(port, host);
  logger.log(`✅ API Gateway listening on http://${host}:${port}`);
  logger.log(`✅ CORS : ${[...origins].join(', ')} + *.${TRUSTED_DOMAINS.join(', *.')} + prévisualisations Vercel`);
}

bootstrap().catch((e) => {
  new Logger('Bootstrap').error(`Échec du démarrage : ${e?.message ?? e}`, e?.stack);
  process.exit(1);
});