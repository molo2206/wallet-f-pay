
// api-gateway/src/main.ts
import { NestFactory } from '@nestjs/core';
import { AppModule } from './app.module';
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.create(AppModule);

  app.enableCors();

  const port = process.env.API_GATEWAY_PORT || 3000;
  await app.listen(port);
  console.log(`API Gateway listening on http://localhost:${port}`);
}

bootstrap();
