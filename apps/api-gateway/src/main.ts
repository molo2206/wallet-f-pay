// api-gateway/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  // ✅ Configuration CORS complète
  app.enableCors({
    origin: [
      'f-pay-eight.vercel.app',
      'http://localhost:3000',
      'http://localhost:4200',
      'http://localhost:3001',
      'http://localhost:4201',
      // Ajoutez d'autres domaines si nécessaire
    ],
    methods: ['GET', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
    allowedHeaders: [
      'Content-Type',
      'Authorization',
      'Accept',
      'X-Requested-With',
      'lang',
      'x-lang',
    ],
    credentials: true,
    maxAge: 86400, // 24 heures
  });

  const port = process.env.API_GATEWAY_PORT || 3000;
  await app.listen(port);
  console.log(`✅ API Gateway listening on http://localhost:${port}`);
  console.log(`✅ CORS enabled for: https://f-pay-eight.vercel.app`);
}

bootstrap();