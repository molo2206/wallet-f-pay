// apps/ACCESPAY/src/main.ts
import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { NotificationModule } from 'apps/notification-service/src/notification.module';
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    NotificationModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
        queue: process.env.NOTIFICATION_QUEUE || 'notification_queue',
        queueOptions: { durable: false },
        noAck: true,
        persistent: true,
      },
    },
  );

  await app.listen();
  console.log(
    '✅ Service de notification en écoute sur la queue :',
    process.env.NOTIFICATION_QUEUE || 'notification_queue',
  );
}

bootstrap();