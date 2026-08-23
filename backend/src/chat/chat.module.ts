import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { SessionsModule } from '../sessions/sessions.module';
import { RagModule } from '../rag/rag.module';
import { ModelsModule } from '../models/models.module';
import { WebToolsService } from '../agent/web-tools.service';

@Module({
  imports: [SessionsModule, RagModule, ModelsModule],
  controllers: [ChatController],
  providers: [ChatService, WebToolsService],
  exports: [ChatService, WebToolsService],
})
export class ChatModule {}
