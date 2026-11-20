import { NestFactory } from '@nestjs/core';
import { MicroserviceOptions, Transport } from '@nestjs/microservices';
import { SettingsServiceModule } from './settings-service.module';

async function bootstrap() {
  const app = await NestFactory.createMicroservice<MicroserviceOptions>(
    SettingsServiceModule, // ← le bon module
    {
      transport: Transport.RMQ,
      options: {
        urls: [process.env.RABBITMQ_URL || 'amqp://localhost:5672'],
        queue: 'settings_queue', // ← la queue dédiée
        queueOptions: { durable: false },
        noAck: true,
        persistent: true,
      },
    },
  );
  await app.listen();
  console.log('✅ Settings service is listening on queue: settings_queue');
}
bootstrap();
