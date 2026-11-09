import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AuditModule } from './audit-service.module';
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  const rabbitmqUrl =
    process.env.RABBITMQ_URL || 'amqp://guest:guest@127.0.0.1:5672';
  console.log('🔍 RABBITMQ_URL:', rabbitmqUrl);

  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AuditModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [rabbitmqUrl],
        queue: 'audit_queue',
        queueOptions: { durable: false },
        noAck: true,
        persistent: true,
      },
    },
  );
  await app.listen();
  console.log('✅ Audit Service is listening on RabbitMQ queue: audit_queue');
}
bootstrap();
