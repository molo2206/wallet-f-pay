import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { AuthServiceModule } from './auth-service.module';
import * as dotenv from 'dotenv';

dotenv.config();

async function bootstrap() {
  console.log('Starting Auth Service...');
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    AuthServiceModule,
    {
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
        queue: 'auth_queue',
        queueOptions: {
          durable: false,
        },        noAck: false,
      },
    },
  );

  await app.listen();
  console.log('✅ Auth Service is listening on RabbitMQ queue: auth_queue');
  console.log(
    `📡 RabbitMQ URL: ${process.env.RABBITMQ_URL || 'amqp://localhost:5672'}`,
  );
}
bootstrap();
