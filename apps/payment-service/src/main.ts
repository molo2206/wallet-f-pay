import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { PaymentServiceModule } from './payment-service.module'; // ✅ Bon import
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    PaymentServiceModule, // Utiliser le bon module
    {
      transport: Transport.TCP,
      options: {
        host: 'localhost',
        port: parseInt(process.env.PAYMENT_SERVICE_PORT || '3005', 10),
      },
    },
  );

  await app.listen();
  console.log(
    `Payment Service running on TCP port ${process.env.PAYMENT_SERVICE_PORT || 3005}`,
  );
}

bootstrap();
