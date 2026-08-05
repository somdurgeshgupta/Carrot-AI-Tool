import { Component, OnInit, ViewChild, ElementRef, ChangeDetectorRef } from '@angular/core';
import { Router } from '@angular/router';
import { ApiService, AIModel, HealthCheckResponse, ChatMessage } from '../../core/services/api.service';
import { AuthService, UserProfile } from '../../core/services/auth.service';
import { SessionsService, ChatSession } from '../../core/services/sessions.service';
import { RagService, UserDocumentSummary } from '../../core/services/rag.service';

@Component({
  selector: 'app-chat',
  templateUrl: './chat.component.html',
  styleUrls: ['./chat.component.css'],
  standalone: false
})
export class ChatComponent implements OnInit {
  @ViewChild('scrollContainer') private scrollContainer!: ElementRef;
  @ViewChild('ragFileInput') private ragFileInput!: ElementRef;

  currentUser: UserProfile | null = null;
  sessions: ChatSession[] = [];
  activeSessionId: string | null = null;

  // Sidebar Collapse & History Popover State
  isSidebarCollapsed: boolean = false;
  showHistoryPopover: boolean = false;

  // Delete Conversation Modal State
  showDeleteConfirmModal: boolean = false;
  sessionToDelete: ChatSession | null = null;

  // Delete RAG Document Modal State
  showDeleteRagDocModal: boolean = false;
  ragDocToDelete: UserDocumentSummary | null = null;

  localModels: AIModel[] = [];
  cloudModels: AIModel[] = [];;
  selectedModelId: string = 'local:llama3.2:3b';
  selectedModelIsLocal: boolean = true;

  health: HealthCheckResponse | null = null;
  messages: ChatMessage[] = [];
  userInput: string = '';
  isGenerating: boolean = false;
  currentStreamText: string = '';

  temperature: number = 0.7;
  systemPrompt: string = '';

  // Settings & RAG Modal States
  showSettingsModal: boolean = false;
  showParamsModal: boolean = false;
  showRagModal: boolean = false;
  isRefreshing: boolean = false;
  localServerUrl: string = 'http://localhost:11434/v1';
  openaiKey: string = '';
  deepseekKey: string = '';
  kimiKey: string = '';
  geminiKey: string = '';
  groqKey: string = '';

  // ── RAG State ──────────────────────────────────────────────
  ragDocuments: UserDocumentSummary[] = [];
  isUploadingRag: boolean = false;
  isDeletingRag: string | null = null;   // filename currently being deleted
  ragUploadError: string = '';
  ragUploadSuccess: string = '';

  constructor(
    private apiService: ApiService,
    private authService: AuthService,
    private sessionsService: SessionsService,
    private ragService: RagService,
    private router: Router,
    private cdr: ChangeDetectorRef
  ) {}

  ngOnInit(): void {
    // Automatically close sidebar by default on mobile devices (<768px)
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      this.isSidebarCollapsed = true;
    }

    this.authService.currentUser$.subscribe((user) => {
      this.currentUser = user;
      if (user) {
        this.loadSessions();
        this.loadRagDocuments();
      }
    });

    this.loadModelsAndHealth();
  }

  // ── Sessions ───────────────────────────────────────────────

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
    // Prevent duplicate empty sessions: If current active session has no messages, reuse it
    if (this.messages.length === 0 && this.activeSessionId) {
      const active = this.sessions.find(s => s.id === this.activeSessionId);
      if (active && (active.title === 'New Conversation' || !active.title)) {
        this.currentStreamText = '';
        if (typeof window !== 'undefined' && window.innerWidth < 768) {
          this.isSidebarCollapsed = true;
        }
        this.cdr.detectChanges();
        return;
      }
    }

    this.sessionsService.createSession('New Conversation', this.selectedModelId).subscribe({
      next: (session) => {
        this.sessions.unshift(session);
        this.activeSessionId = session.id;
        this.messages = [];
        this.currentStreamText = '';
        if (typeof window !== 'undefined' && window.innerWidth < 768) {
          this.isSidebarCollapsed = true;
        }
        this.cdr.detectChanges();
      },
      error: (err) => console.error('Failed to create session', err)
    });
  }

  selectSession(sessionId: string, event?: Event): void {
    if (event) {
      event.stopPropagation();
    }
    this.activeSessionId = sessionId;
    this.showHistoryPopover = false;

    // Automatically close sidebar drawer on mobile (<768px) when a conversation is selected
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      this.isSidebarCollapsed = true;
    }

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

  toggleHistoryPopover(event?: Event): void {
    if (event) event.stopPropagation();
    this.showHistoryPopover = !this.showHistoryPopover;
    this.cdr.detectChanges();
  }

  closeHistoryPopover(): void {
    if (this.showHistoryPopover) {
      this.showHistoryPopover = false;
      this.cdr.detectChanges();
    }
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

  // ── Models & Health ────────────────────────────────────────

  loadModelsAndHealth(): void {
    if (this.isRefreshing) return;
    this.isRefreshing = true;
    const startTime = Date.now();
    this.cdr.detectChanges();

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

        const elapsed = Date.now() - startTime;
        const delay = Math.max(0, 600 - elapsed);
        setTimeout(() => {
          this.isRefreshing = false;
          this.cdr.detectChanges();
        }, delay);
      },
      error: (err) => {
        console.error('Failed to load models', err);
        const elapsed = Date.now() - startTime;
        const delay = Math.max(0, 600 - elapsed);
        setTimeout(() => {
          this.isRefreshing = false;
          this.cdr.detectChanges();
        }, delay);
      }
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

  // ── RAG Mode: 'auto' (smart relevance filter), 'always', or 'off' (default: 'off')
  ragMode: 'auto' | 'always' | 'off' = 'off';

  get canEnableRag(): boolean {
    return this.selectedModelIsLocal && this.ragDocuments.length > 0;
  }

  get ragActive(): boolean {
    if (this.ragMode === 'off') return false;
    return this.selectedModelIsLocal && this.ragDocuments.length > 0;
  }

  setRagMode(mode: 'auto' | 'always' | 'off'): void {
    this.ragMode = mode;
    this.cdr.detectChanges();
  }

  get activeRagDocCount(): number {
    return this.ragDocuments.length;
  }

  getFileIcon(fileType: string): string {
    if (!fileType) return '📃';
    const type = fileType.toLowerCase();
    if (type === 'pdf') return '📄';
    if (type === 'md' || type === 'markdown') return '📝';
    if (['csv', 'tsv', 'json', 'jsonl'].includes(type)) return '📊';
    if (['py', 'js', 'ts', 'html', 'css', 'sql', 'java', 'c', 'cpp', 'sh'].includes(type)) return '💻';
    return '📃';
  }

  // ── RAG Document Management ────────────────────────────────

  loadRagDocuments(): void {
    this.ragService.getDocuments().subscribe({
      next: (docs) => {
        this.ragDocuments = docs;
        this.cdr.detectChanges();
      },
      error: (err) => console.error('Failed to load RAG documents', err)
    });
  }

  triggerRagFileInput(): void {
    this.ragFileInput?.nativeElement.click();
  }

  onRagFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    const file = input?.files?.[0];
    if (!file) return;

    // Reset message states
    this.ragUploadError = '';
    this.ragUploadSuccess = '';
    this.isUploadingRag = true;
    this.cdr.detectChanges();

    this.ragService.uploadDocument(file).subscribe({
      next: (res) => {
        this.ragUploadSuccess = `✅ "${res.fileName}" indexed into ${res.chunkCount} chunks`;
        this.isUploadingRag = false;
        this.loadRagDocuments();
        // Reset file input so same file can be re-uploaded
        if (this.ragFileInput) {
          this.ragFileInput.nativeElement.value = '';
        }
        setTimeout(() => { this.ragUploadSuccess = ''; this.cdr.detectChanges(); }, 4000);
        this.cdr.detectChanges();
      },
      error: (err) => {
        this.ragUploadError = `❌ Upload failed: ${err.error?.message || err.message || 'Unknown error'}`;
        this.isUploadingRag = false;
        this.cdr.detectChanges();
      }
    });
  }

  promptDeleteRagDocument(event: Event, doc: UserDocumentSummary): void {
    event.stopPropagation();
    this.ragDocToDelete = doc;
    this.showDeleteRagDocModal = true;
  }

  confirmDeleteRagDocument(): void {
    if (!this.ragDocToDelete) return;

    const targetFileName = this.ragDocToDelete.fileName;
    this.isDeletingRag = targetFileName;

    this.ragService.deleteDocument(targetFileName).subscribe({
      next: () => {
        this.ragDocuments = this.ragDocuments.filter(d => d.fileName !== targetFileName);
        this.isDeletingRag = null;
        this.showDeleteRagDocModal = false;
        this.ragDocToDelete = null;
        this.cdr.detectChanges();
      },
      error: (err) => {
        console.error('Failed to delete RAG document', err);
        alert(`❌ Deletion failed: ${err.error?.message || err.message || 'Server connection lost. Please try again.'}`);
        this.isDeletingRag = null;
        this.showDeleteRagDocModal = false;
        this.ragDocToDelete = null;
        this.cdr.detectChanges();
      }
    });
  }

  cancelDeleteRagDocument(): void {
    this.showDeleteRagDocModal = false;
    this.ragDocToDelete = null;
  }

  // ── Message Helpers ────────────────────────────────────────

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
    const tag = parts[1] && parts[1].toLowerCase() !== 'local' ? ` (${parts[1].toUpperCase()})` : '';
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

  // ── Send Message ───────────────────────────────────────────

  async sendMessage(): Promise<void> {
    if (!this.userInput.trim() || this.isGenerating) return;

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

    const activeSession = this.sessions.find((s) => s.id === this.activeSessionId);
    if (activeSession && (activeSession.title === 'New Conversation' || !activeSession.title)) {
      activeSession.title = userText.slice(0, 35) + (userText.length > 35 ? '...' : '');
    }

    if (activeSession) {
      this.sessions = [activeSession, ...this.sessions.filter((s) => s.id !== activeSession.id)];
    }

    this.messages.push({ role: 'user', content: userText });
    this.scrollToBottom();

    this.isGenerating = true;
    this.currentStreamText = '';

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: '',
      modelId: this.selectedModelId,
      isLocal: this.selectedModelIsLocal
    };
    this.messages.push(assistantMessage);

    // Only pass RAG fields when local model is active and docs are indexed
    const useRag = this.ragActive && !!this.currentUser?.id;

    const payload = {
      modelId: this.selectedModelId,
      messages: this.messages.slice(0, -1).map(m => ({ role: m.role, content: m.content })),
      sessionId: this.activeSessionId || undefined,
      temperature: this.temperature,
      systemPrompt: this.systemPrompt,
      localServerUrl: this.localServerUrl,
      ragEnabled: useRag,
      userId: useRag ? (this.currentUser?.id || undefined) : undefined,
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

  // ── Misc ───────────────────────────────────────────────────

  clearChat(): void {
    this.messages = [];
    this.currentStreamText = '';
  }

  toggleSidebar(): void {
    this.isSidebarCollapsed = !this.isSidebarCollapsed;
    this.cdr.detectChanges();
  }

  toggleSettingsModal(): void {
    this.showSettingsModal = !this.showSettingsModal;
  }

  toggleRagModal(): void {
    this.showRagModal = !this.showRagModal;
  }

  saveSettings(): void {
    this.showSettingsModal = false;
    this.loadModelsAndHealth();
  }

  logout(): void {
    this.authService.logout();
    this.router.navigate(['/auth']);
  }

  onInputFocus(): void {
    if (typeof window !== 'undefined' && window.innerWidth < 768) {
      this.scrollToBottom();
    }
  }

  private scrollToBottom(): void {
    setTimeout(() => {
      if (this.scrollContainer) {
        this.scrollContainer.nativeElement.scrollTop = this.scrollContainer.nativeElement.scrollHeight;
      }
    }, 50);
  }
}
