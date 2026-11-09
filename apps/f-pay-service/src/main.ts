import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AccespayServiceModule } from './accespay-service.module';
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AccespayServiceModule,
    {
      transport: Transport.TCP,
      options: {
        host: 'localhost',
        port: parseInt(process.env.ACCESPAY_SERVICE_PORT || '3006', 10),
      },
    },
  );

  await app.listen();
  console.log(
    `Accespay Service running on TCP port ${process.env.ACCESPAY_SERVICE_PORT || 3006}`,
  );
}

bootstrap();
