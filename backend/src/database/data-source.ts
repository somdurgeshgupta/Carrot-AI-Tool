import 'reflect-metadata';
import * as dotenv from 'dotenv';
import * as path from 'node:path';
import { DataSource } from 'typeorm';
import { User } from '../entities/user.entity';
import { ChatSession } from '../entities/chat-session.entity';
import { ChatMessageEntity } from '../entities/chat-message.entity';
import { DocumentChunkEntity } from '../entities/document-chunk.entity';
import { KnowledgeSourceEntity } from '../entities/knowledge-source.entity';
import { UserKnowledgeSourceEntity } from '../entities/user-knowledge-source.entity';
import { IngestionJobEntity } from '../entities/ingestion-job.entity';

dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), 'backend', '.env') });

export default new DataSource({
  type: 'postgres',
  host: process.env.POSTGRES_HOST || 'localhost',
  port: Number(process.env.POSTGRES_PORT || 5432),
  username: process.env.POSTGRES_USER || 'postgres',
  password: process.env.POSTGRES_PASSWORD || '1234',
  database: process.env.POSTGRES_DB || 'carrot_ai',
  entities: [
    User,
    ChatSession,
    ChatMessageEntity,
    DocumentChunkEntity,
    KnowledgeSourceEntity,
    UserKnowledgeSourceEntity,
    IngestionJobEntity,
  ],
  migrations: [path.join(__dirname, 'migrations', '*{.ts,.js}')],
  synchronize: false,
});
