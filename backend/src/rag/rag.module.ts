import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentChunkEntity } from '../entities/document-chunk.entity';
import { KnowledgeSourceEntity } from '../entities/knowledge-source.entity';
import { UserKnowledgeSourceEntity } from '../entities/user-knowledge-source.entity';
import { IngestionJobEntity } from '../entities/ingestion-job.entity';
import { IngestionQueueService } from './ingestion-queue.service';
import { RagService } from './rag.service';
import { RagController } from './rag.controller';

@Module({
  imports: [
    TypeOrmModule.forFeature([
      DocumentChunkEntity,
      KnowledgeSourceEntity,
      UserKnowledgeSourceEntity,
      IngestionJobEntity,
    ]),
  ],
  controllers: [RagController],
  providers: [RagService, IngestionQueueService],
  exports: [RagService],
})
export class RagModule {}
