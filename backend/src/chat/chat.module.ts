import { Module } from '@nestjs/common';
import { ChatController } from './chat.controller';
import { ChatService } from './chat.service';
import { SessionsModule } from '../sessions/sessions.module';
import { RagModule } from '../rag/rag.module';
import { ModelsModule } from '../models/models.module';

@Module({
  imports: [SessionsModule, RagModule, ModelsModule],
  controllers: [ChatController],
  providers: [ChatService],
  exports: [ChatService],
})
export class ChatModule {}
