import { Module } from '@nestjs/common';
import { ChatModule } from '../chat/chat.module';
import { AgentController } from './agent.controller';
import { AgentService } from './agent.service';

@Module({
  imports: [ChatModule],
  controllers: [AgentController],
  providers: [AgentService],
})
export class AgentModule {}
