import { CarrotChatMessage } from './carrotClient';

export function hasConversationMessages(messages: CarrotChatMessage[] | undefined): boolean {
  return Boolean(messages?.some((message) => message.role !== 'system'));
}
