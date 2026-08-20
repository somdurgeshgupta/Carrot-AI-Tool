import { Injectable, NotFoundException, ForbiddenException } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { Repository } from 'typeorm';
import { ChatSession } from '../entities/chat-session.entity';
import { ChatMessageEntity } from '../entities/chat-message.entity';
import { User } from '../entities/user.entity';

@Injectable()
export class SessionsService {
  constructor(
    @InjectRepository(ChatSession)
    private readonly sessionRepository: Repository<ChatSession>,
    @InjectRepository(ChatMessageEntity)
    private readonly messageRepository: Repository<ChatMessageEntity>,
    @InjectRepository(User)
    private readonly userRepository: Repository<User>,
  ) {}

  async getUserSessions(userId: string): Promise<ChatSession[]> {
    return this.sessionRepository.find({
      where: { user: { id: userId } },
      order: { updatedAt: 'DESC' },
    });
  }

  async getUserIdentity(userId: string): Promise<{ name: string; email: string }> {
    const user = await this.userRepository.findOne({
      where: { id: userId },
      select: { name: true, email: true },
    });
    if (!user) throw new NotFoundException('User not found');
    return { name: user.name?.trim() || user.email.split('@')[0], email: user.email };
  }

  async getSessionWithMessages(userId: string, sessionId: string): Promise<ChatSession> {
    const session = await this.sessionRepository.findOne({
      where: { id: sessionId },
      relations: { user: true, messages: true },
      order: { messages: { createdAt: 'ASC' } },
    });


    if (!session) {
      throw new NotFoundException('Chat session not found');
    }

    if (session.user.id !== userId) {
      throw new ForbiddenException('Access to chat session denied');
    }

    return session;
  }

  async getCrossConversationContext(userId: string, currentSessionId?: string): Promise<string> {
    const query = this.messageRepository.createQueryBuilder('message')
      .innerJoin('message.session', 'session')
      .innerJoin('session.user', 'user')
      .where('user.id = :userId', { userId })
      .andWhere('message.role = :role', { role: 'user' })
      .orderBy('message.createdAt', 'DESC')
      .take(30);

    if (currentSessionId) {
      query.andWhere('session.id != :currentSessionId', { currentSessionId });
    }

    const messages = await query.getMany();
    return messages
      .reverse()
      .map((message) => message.content.trim())
      .filter(Boolean)
      .join('\n---\n')
      .slice(-12_000);
  }

  async createSession(userId: string, title?: string, modelId?: string): Promise<ChatSession> {
    const user = await this.userRepository.findOne({ where: { id: userId } });
    if (!user) {
      throw new NotFoundException('User not found');
    }

    const session = this.sessionRepository.create({
      title: title?.trim() || 'New Conversation',
      modelId: modelId || 'auto',
      user,
    });

    return this.sessionRepository.save(session);
  }

  async updateSessionTitle(userId: string, sessionId: string, title: string): Promise<ChatSession> {
    const session = await this.getSessionWithMessages(userId, sessionId);
    session.title = title.trim();
    return this.sessionRepository.save(session);
  }

  async deleteSession(userId: string, sessionId: string): Promise<{ success: boolean }> {
    const session = await this.getSessionWithMessages(userId, sessionId);
    await this.sessionRepository.remove(session);
    return { success: true };
  }

  async clearUserSessions(userId: string): Promise<{ success: boolean; deletedCount: number }> {
    const sessions = await this.sessionRepository.find({ where: { user: { id: userId } } });
    if (sessions.length > 0) {
      await this.sessionRepository.remove(sessions);
    }
    return { success: true, deletedCount: sessions.length };
  }

  async appendMessage(userId: string, sessionId: string, role: 'system' | 'user' | 'assistant', content: string, modelId?: string): Promise<ChatMessageEntity> {
    const session = await this.sessionRepository.findOne({
      where: { id: sessionId },
      relations: { user: true },
    });
    if (!session) {
      throw new NotFoundException(`Session ${sessionId} not found`);
    }
    if (session.user.id !== userId) {
      throw new ForbiddenException('Access to chat session denied');
    }

    const msg = this.messageRepository.create({
      role,
      content,
      modelId,
      session,
    });

    const saved = await this.messageRepository.save(msg);

    
    // Auto update session timestamp
    session.updatedAt = new Date();
    // Auto title update if default "New Conversation" or blank
    if ((!session.title || session.title === 'New Conversation') && role === 'user') {
      session.title = content.slice(0, 35) + (content.length > 35 ? '...' : '');
    }

    await this.sessionRepository.save(session);

    return saved;
  }
}
