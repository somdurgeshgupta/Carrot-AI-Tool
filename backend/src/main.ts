import { NestFactory } from '@nestjs/core';
import { ValidationPipe, Logger } from '@nestjs/common';
import { AppModule } from './app.module';
import { json, urlencoded } from 'express';
import {
  createCorsOriginValidator,
  localIpv4Networks,
} from './common/cors-origin';

async function bootstrap() {
  const logger = new Logger('Bootstrap');
  const app = await NestFactory.create(AppModule, { bodyParser: false });

  const bodyLimit = process.env.REQUEST_BODY_LIMIT || '15mb';
  app.use(json({ limit: bodyLimit }));
  app.use(urlencoded({ extended: true, limit: bodyLimit }));

  const corsOrigins = (process.env.CORS_ORIGINS || 'http://localhost:4200')
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);

  const localNetworks = localIpv4Networks();
  app.enableCors({
    origin: createCorsOriginValidator(corsOrigins, localNetworks),
    methods: 'GET,HEAD,PUT,PATCH,POST,DELETE,OPTIONS',
    credentials: true,
  });

  // Set global API prefix (/api)
  app.setGlobalPrefix('api');

  // Enable global validation pipe with transform support
  app.useGlobalPipes(
    new ValidationPipe({
      whitelist: true,
      forbidNonWhitelisted: true,
      transform: true,
    }),
  );

  const port = process.env.PORT ?? 3000;
  await app.listen(port, '0.0.0.0');
  logger.log(`Application is running on: http://localhost:${port}/api`);
  logger.log(
    `CORS allows configured origins and ${localNetworks.length} detected local IPv4 subnet(s)`,
  );
}
bootstrap();
