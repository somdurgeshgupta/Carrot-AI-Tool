import { Injectable } from '@nestjs/common';
import { ChatService } from '../chat/chat.service';
import { AgentTurnDto } from './agent.controller';
import { WebToolsService } from './web-tools.service';

@Injectable()
export class AgentService {
  constructor(private readonly chatService: ChatService, private readonly webTools: WebToolsService) {}

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
    return this.webTools.search(query);
  }

  fetchUrl(url: string) { return this.webTools.fetchUrl(url); }
}
