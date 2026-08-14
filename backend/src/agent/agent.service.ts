import { Injectable } from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import { AgentTurnDto } from './agent.controller';

@Injectable()
export class AgentService {
  constructor(private readonly chatService: ChatService) {}

  turn(userId: string, dto: AgentTurnDto) {
    return this.chatService.handleChatCompletion({
      modelId: dto.modelId,
      localOnly: dto.localOnly,
      systemPrompt: dto.systemPrompt,
      messages: dto.messages,
      stream: false,
      ragEnabled: false,
      webSearchEnabled: false,
      agentTask: true,
    }, userId);
  }

  async webSearch(query: string) {
    const results = await this.chatService.performWebSearch(query.trim());
    return { query: query.trim(), results };
  }
}
