import { ForbiddenException } from '@nestjs/common';
import { SessionsService } from './sessions.service';

describe('SessionsService', () => {
  const repository = (overrides: Record<string, jest.Mock> = {}) => ({
    find: jest.fn(),
    findOne: jest.fn(),
    remove: jest.fn(),
    create: jest.fn(),
    save: jest.fn(),
    ...overrides,
  });

  it('blocks deletion of another user session', async () => {
    const sessions = repository({
      findOne: jest.fn().mockResolvedValue({ id: 'session-1', user: { id: 'owner' }, messages: [] }),
    });
    const service = new SessionsService(sessions as any, repository() as any, repository() as any);
    await expect(service.deleteSession('attacker', 'session-1')).rejects.toBeInstanceOf(ForbiddenException);
    expect(sessions.remove).not.toHaveBeenCalled();
  });

  it('clears only sessions belonging to the authenticated user', async () => {
    const owned = [{ id: 'one' }, { id: 'two' }];
    const sessions = repository({ find: jest.fn().mockResolvedValue(owned) });
    const service = new SessionsService(sessions as any, repository() as any, repository() as any);
    await expect(service.clearUserSessions('user-1')).resolves.toEqual({ success: true, deletedCount: 2 });
    expect(sessions.find).toHaveBeenCalledWith({ where: { user: { id: 'user-1' } } });
    expect(sessions.remove).toHaveBeenCalledWith(owned);
  });

  it('returns only the authenticated user identity for chat personalization', async () => {
    const users = repository({
      findOne: jest.fn().mockResolvedValue({ name: 'Som Durgesh', email: 'som@example.com' }),
    });
    const service = new SessionsService(repository() as any, repository() as any, users as any);

    await expect(service.getUserIdentity('user-1')).resolves.toEqual({ name: 'Som Durgesh', email: 'som@example.com' });
    expect(users.findOne).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      select: { name: true, email: true },
    });
  });

  it('blocks appending agent messages to another user session', async () => {
    const sessions = repository({
      findOne: jest.fn().mockResolvedValue({ id: 'session-1', user: { id: 'owner' } }),
    });
    const messages = repository();
    const service = new SessionsService(sessions as any, messages as any, repository() as any);
    await expect(service.appendMessage('attacker', 'session-1', 'assistant', 'content')).rejects.toBeInstanceOf(ForbiddenException);
    expect(messages.save).not.toHaveBeenCalled();
  });

  it('scopes cross-conversation memory to the authenticated user and excludes the active session', async () => {
    const query = {
      innerJoin: jest.fn().mockReturnThis(),
      where: jest.fn().mockReturnThis(),
      andWhere: jest.fn().mockReturnThis(),
      orderBy: jest.fn().mockReturnThis(),
      take: jest.fn().mockReturnThis(),
      getMany: jest.fn().mockResolvedValue([{ content: 'I prefer concise answers.' }]),
    };
    const messages = repository({ createQueryBuilder: jest.fn().mockReturnValue(query) });
    const service = new SessionsService(repository() as any, messages as any, repository() as any);

    await expect(service.getCrossConversationContext('user-1', 'session-2')).resolves.toBe('I prefer concise answers.');
    expect(query.where).toHaveBeenCalledWith('user.id = :userId', { userId: 'user-1' });
    expect(query.andWhere).toHaveBeenCalledWith('session.id != :currentSessionId', { currentSessionId: 'session-2' });
  });
});
