// apps/wallet-service/src/main.ts
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { WalletServiceModule } from './wallet-service.module';
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    WalletServiceModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL || 'amqp://guest:guest@localhost:5672'],
        queue: 'wallet_queue',
        queueOptions: { durable: false },
        noAck: true,
        persistent: true,
      },
    },
  );

  await app.listen();
  console.log('✅ Wallet Service is listening on RabbitMQ queue: wallet_queue');
}

bootstrap();
