import { Component, OnInit, ViewChild, ElementRef, ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService, AIModel, HealthCheckResponse, ChatMessage } from '../../core/services/api.service';
import { AuthService, UserProfile } from '../../core/services/auth.service';
import { SessionsService, ChatSession } from '../../core/services/sessions.service';

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css'],
  standalone: false
})
export class ChatComponent implements OnInit {
  @ViewChild('scrollContainer') private scrollContainer!: ElementRef;

  currentUser: UserProfile | null = null;
  sessions: ChatSession[] = [];
  activeSessionId: string | null = null;

  // Delete Confirmation Modal State
  showDeleteConfirmModal: boolean = false;
  sessionToDelete: ChatSession | null = null;

  localModels: AIModel[] = [];
  cloudModels: AIModel[] = [];
  selectedModelId: string = 'local:llama3.2:3b';
  selectedModelIsLocal: boolean = true;

  health: HealthCheckResponse | null = null;
  messages: ChatMessage[] = [];
  userInput: string = '';
  isGenerating: boolean = false;
  currentStreamText: string = '';

  temperature: number = 0.7;
  systemPrompt: string = '';

  // Settings Modal State
  showSettingsModal: boolean = false;
  showParamsModal: boolean = false;
  localServerUrl: string = 'http://localhost:11434/v1';
  openaiKey: string = '';
  deepseekKey: string = '';
  kimiKey: string = '';
  geminiKey: string = '';
  groqKey: string = '';

  constructor(
    private apiService: ApiService,
    private authService: AuthService,
    private sessionsService: SessionsService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    this.authService.currentUser$.subscribe((user) => {
      this.currentUser = user;
      if (user) {
        this.loadSessions();
      }
    });

    this.loadModelsAndHealth();
  }

  loadSessions(): void {
    this.sessionsService.getSessions().subscribe({
      next: (sessions) => {
        this.sessions = sessions;
        if (sessions.length > 0 && !this.activeSessionId) {
          this.selectSession(sessions[0].id);
        }
        this.cdr.detectChanges();
      },
      error: (err) => console.error('Failed to load sessions', err)
    });
  }

  createNewSession(): void {
    this.sessionsService.createSession('New Conversation', this.selectedModelId).subscribe({
      next: (session) => {
        this.sessions.unshift(session);
        this.activeSessionId = session.id;
        this.messages = [];
        this.cdr.detectChanges();
      },
      error: (err) => console.error('Failed to create session', err)
    });
  }

  selectSession(sessionId: string): void {
    this.activeSessionId = sessionId;
    this.sessionsService.getSessionDetails(sessionId).subscribe({
      next: (session) => {
        if (session.modelId) {
          this.selectedModelId = session.modelId;
          this.updateModelType();
        }
        this.messages = (session.messages || []).map((m) => ({
          role: m.role,
          content: m.content,
          modelId: (m as any).modelId,
          isLocal: (m as any).modelId ? (m as any).modelId.startsWith('local') : undefined
        }));
        this.scrollToBottom();
        this.cdr.detectChanges();
      },
      error: (err) => console.error('Failed to load session details', err)
    });
  }

  promptDeleteSession(event: Event, session: ChatSession): void {
    event.stopPropagation();
    this.sessionToDelete = session;
    this.showDeleteConfirmModal = true;
  }

  confirmDeleteSession(): void {
    if (!this.sessionToDelete) return;

    const targetId = this.sessionToDelete.id;
    this.sessionsService.deleteSession(targetId).subscribe({
      next: () => {
        this.sessions = this.sessions.filter((s) => s.id !== targetId);
        if (this.activeSessionId === targetId) {
          this.activeSessionId = this.sessions[0]?.id || null;
          if (this.activeSessionId) {
            this.selectSession(this.activeSessionId);
          } else {
            this.messages = [];
          }
        }
        this.showDeleteConfirmModal = false;
        this.sessionToDelete = null;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to delete session', err);
        this.showDeleteConfirmModal = false;
      }
    });
  }

  cancelDeleteSession(): void {
    this.showDeleteConfirmModal = false;
    this.sessionToDelete = null;
  }

  loadModelsAndHealth(): void {
    this.apiService.checkHealth(this.localServerUrl).subscribe({
      next: (res) => {
        this.health = res;
        this.cdr.detectChanges();
      },
      error: (err) => console.error('Health check failed', err)
    });

    this.apiService.getModels(this.localServerUrl).subscribe({
      next: (data) => {
        this.localModels = data.local;
        this.cloudModels = data.cloud;

        const allAvailable = [...this.localModels, ...this.cloudModels].filter(m => m.available);
        if (allAvailable.length > 0 && !allAvailable.some(m => m.id === this.selectedModelId)) {
          this.selectedModelId = allAvailable[0].id;
        }
        this.updateModelType();
        this.cdr.detectChanges();
      },
      error: (err) => console.error('Failed to load models', err)
    });
  }

  onModelChange(newModelId: string): void {
    this.selectedModelId = newModelId;
    this.updateModelType();
  }

  updateModelType(): void {
    const foundLocal = this.localModels.find(m => m.id === this.selectedModelId);
    this.selectedModelIsLocal = Boolean(foundLocal);
  }

  getActiveModelName(): string {
    const all = [...this.localModels, ...this.cloudModels];
    const match = all.find(m => m.id === this.selectedModelId);
    return match ? match.name : this.selectedModelId;
  }

  getMessageModelName(msg: ChatMessage): string {
    if (msg.role === 'user') return 'You';
    const targetId = msg.modelId || this.selectedModelId;
    const all = [...this.localModels, ...this.cloudModels];
    const match = all.find((m) => m.id === targetId);
    if (match) return match.name;
    return this.formatModelId(targetId);
  }

  private formatModelId(id: string): string {
    if (!id) return 'AI Assistant';
    const clean = id.replace(/^(local|groq|gemini|openai|deepseek|kimi):/, '').replace(/:latest$/, '');
    const parts = clean.split(':');
    const baseName = parts[0].split(/[\-_]/).map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
    const tag = parts[1] ? ` (${parts[1].toUpperCase()})` : '';
    return `${baseName}${tag}`;
  }

  isMessageLocal(msg: ChatMessage): boolean {
    if (msg.isLocal !== undefined) return msg.isLocal;
    if (msg.modelId) return msg.modelId.startsWith('local');
    return this.selectedModelIsLocal;
  }

  usePresetPrompt(prompt: string): void {
    this.userInput = prompt;
    this.sendMessage();
  }

  onKeyDown(event: KeyboardEvent): void {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      this.sendMessage();
    }
  }

  cleanResponseText(text: string): string {
    if (!text) return '';
    let cleaned = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (cleaned === '' && text.includes('<think>')) {
      return '🧠 Thinking...';
    }
    return cleaned || text;
  }

  async sendMessage(): Promise<void> {
    if (!this.userInput.trim() || this.isGenerating) return;

    // Auto-create session if none active
    if (!this.activeSessionId) {
      this.sessionsService.createSession('New Conversation', this.selectedModelId).subscribe({
        next: async (session) => {
          this.sessions.unshift(session);
          this.activeSessionId = session.id;
          await this.executeSendMessage();
        }
      });
      return;
    }

    await this.executeSendMessage();
  }

  private async executeSendMessage(): Promise<void> {
    const userText = this.userInput.trim();
    this.userInput = '';

    // Instantly update active session title in sidebar if new conversation
    const activeSession = this.sessions.find((s) => s.id === this.activeSessionId);
    if (activeSession && (activeSession.title === 'New Conversation' || !activeSession.title)) {
      activeSession.title = userText.slice(0, 35) + (userText.length > 35 ? '...' : '');
    }

    // Move active session to top of list
    if (activeSession) {
      this.sessions = [activeSession, ...this.sessions.filter((s) => s.id !== activeSession.id)];
    }

    // Append user message
    this.messages.push({ role: 'user', content: userText });
    this.scrollToBottom();

    this.isGenerating = true;
    this.currentStreamText = '';

    // Append assistant placeholder with specific model tracking!
    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: '',
      modelId: this.selectedModelId,
      isLocal: this.selectedModelIsLocal
    };
    this.messages.push(assistantMessage);

    const payload = {
      modelId: this.selectedModelId,
      messages: this.messages.slice(0, -1), // Exclude placeholder
      sessionId: this.activeSessionId || undefined,
      temperature: this.temperature,
      systemPrompt: this.systemPrompt,
      localServerUrl: this.localServerUrl,
      apiKeys: {
        openaiApiKey: this.openaiKey,
        deepseekApiKey: this.deepseekKey,
        kimiApiKey: this.kimiKey,
        geminiApiKey: this.geminiKey,
        groqApiKey: this.groqKey
      }
    };

    await this.apiService.streamChat(
      payload,
      (chunk: string) => {
        this.currentStreamText += chunk;
        assistantMessage.content = this.currentStreamText;
        this.scrollToBottom();
        this.cdr.detectChanges();
      },
      (error: any) => {
        this.isGenerating = false;
        assistantMessage.content = `⚠️ Error: ${error.message || 'Failed to receive completion from AI provider.'}`;
        this.cdr.detectChanges();
      }
    );

    this.isGenerating = false;
    this.cdr.detectChanges();
  }

  clearChat(): void {
    this.messages = [];
    this.currentStreamText = '';
  }

  toggleSettingsModal(): void {
    this.showSettingsModal = !this.showSettingsModal;
  }

  saveSettings(): void {
    this.showSettingsModal = false;
    this.loadModelsAndHealth();
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/auth']);
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      if (this.scrollContainer) {
        this.scrollContainer.nativeElement.scrollTop = this.scrollContainer.nativeElement.scrollHeight;
      }
    }, 50);
  }
}
