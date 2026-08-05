import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DocumentChunkEntity } from '../entities/document-chunk.entity';
import { RagService } from './rag.service';
import { RagController } from './rag.controller';

@Module({
  imports: [TypeOrmModule.forFeature([DocumentChunkEntity])],
  controllers: [RagController],
  providers: [RagService],
  exports: [RagService],
})
export class RagModule {}
