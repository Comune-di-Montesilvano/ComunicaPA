import { NestFactory } from '@nestjs/core';
import { ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';

async function bootstrap(): Promise<void> {
  const app = await NestFactory.create(AppModule);

  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  app.enableCors({
    origin: [
      'http://localhost:3000',
      'http://localhost:3001',
      process.env['ADMIN_ORIGIN'] ?? '',
      process.env['CITIZEN_ORIGIN'] ?? '',
    ].filter(Boolean),
    credentials: true,
  });

  const port = Number(process.env['PORT'] ?? 8080);
  await app.listen(port, '0.0.0.0');
  console.log(`Backend running on http://0.0.0.0:${port}`);
}

void bootstrap();
