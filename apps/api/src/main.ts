import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { ConfigService } from '@nestjs/config';
import { Logger, ValidationPipe } from '@nestjs/common';
import { AppModule } from './app.module';
import { checkStartupConfig } from './config/startup-check';

async function bootstrap(): Promise<void> {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { logger: ['log', 'warn', 'error'] });

  const config = app.get(ConfigService);
  checkStartupConfig(config);

  app.setGlobalPrefix('api');
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      transform: true,
      forbidNonWhitelisted: false,
    }),
  );

  const corsOrigins = config.get<string[]>('corsOrigins', ['http://localhost:4200']);
  app.enableCors({ origin: corsOrigins, credentials: true });

  const port = config.get<number>('port', 3000);
  await app.listen(port, '0.0.0.0');
  logger.log(`API listening on :${port} (prefix: /api)`);
}

bootstrap().catch((error) => {
  // eslint-disable-next-line no-console
  console.error('Fatal error during bootstrap:', error);
  process.exit(1);
});
