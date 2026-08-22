import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { TypeOrmModule } from '@nestjs/typeorm';
import * as dotenv from 'dotenv';
import * as path from 'path';
import { AppController } from './app.controller';
import { AppService } from './app.service';
import { HealthModule } from './health/health.module';
import { ModelsModule } from './models/models.module';
import { ChatModule } from './chat/chat.module';
import { AuthModule } from './auth/auth.module';
import { SessionsModule } from './sessions/sessions.module';
import { RagModule } from './rag/rag.module';
import { User } from './entities/user.entity';
import { ChatSession } from './entities/chat-session.entity';
import { ChatMessageEntity } from './entities/chat-message.entity';
import { DocumentChunkEntity } from './entities/document-chunk.entity';
import { KnowledgeSourceEntity } from './entities/knowledge-source.entity';
import { UserKnowledgeSourceEntity } from './entities/user-knowledge-source.entity';
import { IngestionJobEntity } from './entities/ingestion-job.entity';
import { AgentModule } from './agent/agent.module';
import { CacheModule } from './cache/cache.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', 'backend/.env'],
    }),
    TypeOrmModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (configService: ConfigService) => {
        const backendPath = path.resolve(process.cwd(), 'backend', '.env');
        const rootPath = path.resolve(process.cwd(), '.env');
        dotenv.config({ path: backendPath, override: true });
        dotenv.config({ path: rootPath, override: true });

        return {
          type: 'postgres',
          host:
            process.env.POSTGRES_HOST ||
            configService.get<string>('POSTGRES_HOST') ||
            'localhost',
          port: parseInt(
            process.env.POSTGRES_PORT ||
              configService.get<string>('POSTGRES_PORT') ||
              '5432',
            10,
          ),
          username:
            process.env.POSTGRES_USER ||
            configService.get<string>('POSTGRES_USER') ||
            'postgres',
          password:
            process.env.POSTGRES_PASSWORD ||
            configService.get<string>('POSTGRES_PASSWORD') ||
            '1234',
          database:
            process.env.POSTGRES_DB ||
            configService.get<string>('POSTGRES_DB') ||
            'carrot_ai',
          entities: [
            User,
            ChatSession,
            ChatMessageEntity,
            DocumentChunkEntity,
            KnowledgeSourceEntity,
            UserKnowledgeSourceEntity,
            IngestionJobEntity,
          ],
          migrations: [
            path.join(__dirname, 'database', 'migrations', '*{.ts,.js}'),
          ],
          synchronize: false,
          migrationsRun: false,
        };
      },
    }),
    HealthModule,
    ModelsModule,
    ChatModule,
    AuthModule,
    SessionsModule,
    RagModule,
    AgentModule,
    CacheModule,
  ],
  controllers: [AppController],
  providers: [AppService],
})
export class AppModule {}
