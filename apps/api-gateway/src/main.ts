// api-gateway/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  const allowedOrigins = [
    'https://f-pay-eight.vercel.app',
    'http://localhost:3000',
    'http://localhost:4200',
  ];

  app.enableCors({
    origin: (origin, callback) => {
      if (!origin) return callback(null, true);
      if (allowedOrigins.includes(origin) || process.env.NODE_ENV === 'development') {
        callback(null, true);
      } else {
        callback(new Error(`Origin ${origin} not allowed by CORS`));
      }
    },
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
    maxAge: 86400,
  });

  const port = process.env.API_GATEWAY_PORT || 3000;
  await app.listen(port);
  console.log(`✅ API Gateway listening on http://localhost:${port}`);
  console.log(`✅ CORS allowed origins: ${allowedOrigins.join(', ')}`);
}

bootstrap();