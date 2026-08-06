import { Component, OnInit, ViewChild, ElementRef, ChangeDetectorRef, NgZone } from '@angular/core';
import { Router } from '@angular/router';
import { DomSanitizer, SafeHtml } from '@angular/platform-browser';
import { marked } from 'marked';
import { ApiService, AIModel, HealthCheckResponse, ChatMessage } from '../../core/services/api.service';
import { AuthService, UserProfile } from '../../core/services/auth.service';
import { SessionsService, ChatSession } from '../../core/services/sessions.service';
import { RagService, UserDocumentSummary } from '../../core/services/rag.service';

marked.use({
  gfm: true,
  breaks: true,
  renderer: {
    code({ text, lang }: { text: string; lang?: string }) {
      const language = (lang || 'code').trim();
      const escapedCode = text
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;');
      return `<div class="code-block-wrapper"><div class="code-block-header"><span class="code-lang-label">${language.toUpperCase()}</span><div class="code-header-actions"><button class="code-action-btn btn-code-preview" data-preview-code="${encodeURIComponent(text)}" data-lang="${language}" title="Preview in right panel">👁️ Preview</button><button class="code-action-btn btn-code-download" data-download-code="${encodeURIComponent(text)}" data-lang="${language}" title="Download file">📥 Download</button><button class="code-copy-btn" data-code="${encodeURIComponent(text)}" title="Copy code snippet">📋</button></div></div><pre><code class="language-${language}">${escapedCode}</code></pre></div>`;
    }
  }
});

export interface AttachedFile {
  name: string;
  size: number;
  type: string;
  extension: string;
  content: string;
  dataUrl?: string;
}

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
  cloudModels: AIModel[] = [];
  selectedModelId: string = 'local:qwen3:8b';
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

  // Track active background streams per session so queries never disappear when switching pages
  activeSessionStreams = new Map<string, { assistantMessage: ChatMessage; fullText: string; isGenerating: boolean }>();

  constructor(
    private apiService: ApiService,
    private authService: AuthService,
    private sessionsService: SessionsService,
    private ragService: RagService,
    private router: Router,
    private cdr: ChangeDetectorRef,
    private sanitizer: DomSanitizer,
    private ngZone: NgZone
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

  getDefaultModelId(availableModels?: AIModel[]): string {
    const models = availableModels || [...this.localModels, ...this.cloudModels].filter(m => m.available);
    if (!models || models.length === 0) {
      return 'local:qwen3:8b';
    }

    if (typeof localStorage !== 'undefined') {
      const pref = localStorage.getItem('carrot_preferred_model');
      if (pref && !pref.includes('llama') && models.some(m => m.id === pref)) {
        return pref;
      }
    }

    const qwen3 = models.find(m => m.id.toLowerCase().includes('qwen3') || m.id.toLowerCase().includes('qwen-3'));
    if (qwen3) return qwen3.id;

    const anyQwen = models.find(m => m.id.toLowerCase().includes('qwen'));
    if (anyQwen) return anyQwen.id;

    const firstLocal = models.find(m => m.isLocal);
    if (firstLocal) return firstLocal.id;

    return models[0].id;
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
    // Always default new conversation model to Qwen 3 8B
    this.selectedModelId = this.getDefaultModelId();
    this.updateModelType();

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
          if (session.modelId.includes('llama')) {
            const savedPref = typeof localStorage !== 'undefined' ? localStorage.getItem('carrot_preferred_model') : null;
            this.selectedModelId = savedPref || this.getDefaultModelId();
          } else {
            this.selectedModelId = session.modelId;
          }
          this.updateModelType();
        }
        this.messages = (session.messages || []).map((m) => ({
          role: m.role,
          content: m.content,
          modelId: (m as any).modelId,
          isLocal: (m as any).modelId ? (m as any).modelId.startsWith('local') : undefined
        }));

        // Check if there is an active background stream for this session
        const activeStream = this.activeSessionStreams.get(sessionId);
        if (activeStream && activeStream.isGenerating) {
          const lastMsg = this.messages[this.messages.length - 1];
          if (!lastMsg || lastMsg !== activeStream.assistantMessage) {
            this.messages.push(activeStream.assistantMessage);
          }
          this.currentStreamText = activeStream.fullText;
          this.isGenerating = true;
        } else {
          this.isGenerating = false;
          this.currentStreamText = '';
        }

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
        const qwenModel = allAvailable.find(m => m.id.toLowerCase().includes('qwen'));
        if (qwenModel) {
          this.selectedModelId = qwenModel.id;
        } else if (allAvailable.length > 0) {
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
    if (typeof localStorage !== 'undefined') {
      localStorage.setItem('carrot_preferred_model', newModelId);
    }
  }

  selectedModelIsVision: boolean = false;

  updateModelType(): void {
    const foundLocal = this.localModels.find(m => m.id === this.selectedModelId);
    this.selectedModelIsLocal = Boolean(foundLocal);

    const lowerId = (this.selectedModelId || '').toLowerCase();
    const isCloud = !this.selectedModelIsLocal || lowerId.includes('gemini') || lowerId.includes('openai') || lowerId.includes('groq');
    this.selectedModelIsVision = isCloud || lowerId.includes('llava') || lowerId.includes('vision');
  }

  get hasAttachedImages(): boolean {
    return this.attachedFiles.some(f => f.dataUrl && (f.dataUrl.startsWith('data:image/') || ['png','jpg','jpeg','webp','gif'].includes(f.extension)));
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

  toggleRagMode(): void {
    if (this.ragMode === 'off') {
      this.ragMode = 'auto';
    } else if (this.ragMode === 'auto') {
      this.ragMode = 'always';
    } else {
      this.ragMode = 'off';
    }
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

  // ── Option A: Selective RAG Checkboxes ──────────────────────
  selectedDocNames: Set<string> = new Set();

  toggleDocSelection(fileName: string): void {
    if (this.selectedDocNames.has(fileName)) {
      this.selectedDocNames.delete(fileName);
    } else {
      this.selectedDocNames.add(fileName);
    }
    this.cdr.detectChanges();
  }

  isDocSelected(fileName: string): boolean {
    return this.selectedDocNames.has(fileName);
  }

  selectAllDocs(): void {
    this.ragDocuments.forEach(d => this.selectedDocNames.add(d.fileName));
    this.cdr.detectChanges();
  }

  deselectAllDocs(): void {
    this.selectedDocNames.clear();
    this.cdr.detectChanges();
  }

  // ── Option B: Citations & Source Footnotes ─────────────────
  showCitationModal: boolean = false;
  citationToPreview: { fileName: string; content: string; chunkIndex?: number } | null = null;

  openCitationPreview(citation: { fileName: string; content: string; chunkIndex?: number }): void {
    this.citationToPreview = citation;
    this.showCitationModal = true;
    this.cdr.detectChanges();
  }

  closeCitationPreview(): void {
    this.showCitationModal = false;
    this.citationToPreview = null;
    this.cdr.detectChanges();
  }

  // ── Option C: Chat Session Export (Markdown / JSON / Text) ──
  showExportModal: boolean = false;

  toggleExportModal(): void {
    this.showExportModal = !this.showExportModal;
    this.cdr.detectChanges();
  }

  exportChat(format: 'md' | 'json' | 'txt'): void {
    if (this.messages.length === 0) return;
    const sessionTitle = this.sessions.find(s => s.id === this.activeSessionId)?.title || 'chat-transcript';
    const safeTitle = sessionTitle.toLowerCase().replace(/[^a-z0-9]/g, '-');

    let fileContent = '';
    let mimeType = 'text/plain';
    let fileExt = 'txt';

    if (format === 'md') {
      mimeType = 'text/markdown';
      fileExt = 'md';
      fileContent = `# ${sessionTitle}\n*Exported from Carrot AI Gateway*\n\n---\n\n`;
      this.messages.forEach((msg) => {
        const roleName = msg.role === 'user' ? '👤 User' : '🤖 Carrot AI';
        fileContent += `### ${roleName}\n${msg.content}\n\n`;
      });
    } else if (format === 'json') {
      mimeType = 'application/json';
      fileExt = 'json';
      fileContent = JSON.stringify({ title: sessionTitle, exportedAt: new Date(), messages: this.messages }, null, 2);
    } else {
      fileContent = `${sessionTitle.toUpperCase()}\n=====================\n\n`;
      this.messages.forEach((msg) => {
        const roleName = msg.role === 'user' ? 'USER' : 'CARROT AI';
        fileContent += `[${roleName}]:\n${msg.content}\n\n---------------------\n\n`;
      });
    }

    const blob = new Blob([fileContent], { type: `${mimeType};charset=utf-8` });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `${safeTitle}.${fileExt}`;
    a.click();
    URL.revokeObjectURL(url);
    this.showExportModal = false;
  }

  // ── Option D: Web Search Integration ───────────────────────
  webSearchEnabled: boolean = false;

  toggleWebSearch(): void {
    this.webSearchEnabled = !this.webSearchEnabled;
    this.cdr.detectChanges();
  }

  // ── ChatGPT Voice Mode (Continuous Speech-to-Text) ─────────
  isListening: boolean = false;
  voiceTranscript: string = '';
  private speechRecognition: any = null;
  private shouldKeepListening: boolean = false;

  toggleVoiceInput(): void {
    if (this.isListening) {
      this.stopVoiceInput();
      return;
    }

    const SpeechRecognitionClass = (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionClass) {
      alert('Speech Recognition is not supported by your browser. Please use Chrome, Edge, or Safari.');
      return;
    }

    try {
      this.speechRecognition = new SpeechRecognitionClass();
      this.speechRecognition.continuous = true;
      this.speechRecognition.interimResults = true;
      this.speechRecognition.lang = 'en-US';

      this.shouldKeepListening = true;
      this.voiceTranscript = this.userInput;

      this.speechRecognition.onstart = () => {
        this.ngZone.run(() => {
          this.isListening = true;
          this.cdr.detectChanges();
        });
      };

      this.speechRecognition.onresult = (event: any) => {
        this.ngZone.run(() => {
          let interimTranscript = '';
          let finalTranscript = '';

          for (let i = 0; i < event.results.length; i++) {
            const transcript = event.results[i][0].transcript;
            if (event.results[i].isFinal) {
              finalTranscript += transcript + ' ';
            } else {
              interimTranscript += transcript;
            }
          }

          const fullText = (finalTranscript + interimTranscript).trim();
          if (fullText) {
            this.userInput = fullText;
            this.voiceTranscript = fullText;
          }
          this.cdr.detectChanges();
        });
      };

      this.speechRecognition.onerror = (err: any) => {
        this.ngZone.run(() => {
          console.error('Speech recognition error:', err);
          if (err.error === 'no-speech' || err.error === 'network') {
            return;
          }
          if (err.error === 'not-allowed') {
            alert('Microphone permission denied. Please allow microphone access in browser settings.');
            this.stopVoiceInput();
          }
          this.cdr.detectChanges();
        });
      };

      this.speechRecognition.onend = () => {
        this.ngZone.run(() => {
          if (this.shouldKeepListening && this.isListening) {
            try {
              this.speechRecognition.start();
            } catch (e) {}
          } else {
            this.isListening = false;
          }
          this.cdr.detectChanges();
        });
      };

      this.speechRecognition.start();
    } catch (e) {
      console.error('Failed to start speech recognition', e);
      this.ngZone.run(() => {
        this.isListening = false;
        this.shouldKeepListening = false;
        this.cdr.detectChanges();
      });
    }
  }

  stopVoiceInput(sendImmediately: boolean = false): void {
    this.shouldKeepListening = false;
    if (this.speechRecognition) {
      try {
        this.speechRecognition.stop();
      } catch (e) {}
    }
    this.ngZone.run(() => {
      this.isListening = false;
      this.cdr.detectChanges();
    });

    if (sendImmediately && this.userInput.trim()) {
      this.sendMessage();
    }
  }

  // ── RAG Document Management ────────────────────────────────

  loadRagDocuments(): void {
    this.ragService.getDocuments().subscribe({
      next: (docs) => {
        this.ragDocuments = docs;
        if (this.selectedDocNames.size === 0) {
          docs.forEach(d => this.selectedDocNames.add(d.fileName));
        }
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

  // ── Input Box Attached Files & Documents ────────────────────
  attachedFiles: AttachedFile[] = [];

  private async extractImageTextWithOCR(dataUrl: string): Promise<string> {
    return new Promise((resolve) => {
      try {
        if (typeof window !== 'undefined' && (window as any).Tesseract) {
          (window as any).Tesseract.recognize(dataUrl, 'eng').then((result: any) => {
            resolve((result?.data?.text || '').trim());
          }).catch(() => resolve(''));
        } else if (typeof document !== 'undefined') {
          const existingScript = document.querySelector('script[src*="tesseract"]');
          if (existingScript) {
            setTimeout(async () => {
              if ((window as any).Tesseract) {
                try {
                  const res = await (window as any).Tesseract.recognize(dataUrl, 'eng');
                  resolve((res?.data?.text || '').trim());
                } catch { resolve(''); }
              } else { resolve(''); }
            }, 1000);
            return;
          }
          const script = document.createElement('script');
          script.src = 'https://cdn.jsdelivr.net/npm/tesseract.js@5/dist/tesseract.min.js';
          script.onload = () => {
            if ((window as any).Tesseract) {
              (window as any).Tesseract.recognize(dataUrl, 'eng').then((result: any) => {
                resolve((result?.data?.text || '').trim());
              }).catch(() => resolve(''));
            } else {
              resolve('');
            }
          };
          script.onerror = () => resolve('');
          document.head.appendChild(script);
        } else {
          resolve('');
        }
      } catch (e) {
        resolve('');
      }
    });
  }

  onFileSelected(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (!input.files || input.files.length === 0) return;

    Array.from(input.files).forEach((file) => {
      const extension = file.name.split('.').pop()?.toLowerCase() || '';
      const reader = new FileReader();

      if (['pdf', 'png', 'jpg', 'jpeg', 'webp', 'bmp'].includes(extension) || file.type.includes('pdf') || file.type.startsWith('image/')) {
        reader.onload = (e) => {
          const dataUrl = (e.target?.result as string) || '';
          this.apiService.extractDocumentText(file.name, dataUrl).subscribe({
            next: (res) => {
              this.ngZone.run(() => {
                this.attachedFiles.push({
                  name: file.name,
                  size: file.size,
                  type: file.type || 'application/octet-stream',
                  extension,
                  content: res.text || `[Document/Image: ${file.name}]`,
                  dataUrl
                });
                this.cdr.detectChanges();
              });
            },
            error: async (err) => {
              console.warn('Backend document text extraction error, trying client OCR', err);
              const ocrText = await this.extractImageTextWithOCR(dataUrl);
              this.ngZone.run(() => {
                this.attachedFiles.push({
                  name: file.name,
                  size: file.size,
                  type: file.type || 'application/octet-stream',
                  extension,
                  content: ocrText ? `[Extracted Image Text (OCR)]:\n${ocrText}` : `[Document/Image: ${file.name}]`,
                  dataUrl
                });
                this.cdr.detectChanges();
              });
            }
          });
        };
        reader.readAsDataURL(file);
      } else if (file.type.startsWith('text/') || ['json', 'js', 'ts', 'py', 'md', 'html', 'css', 'sql', 'c', 'cpp', 'java', 'csv', 'yaml', 'yml', 'xml', 'txt', 'sh'].includes(extension)) {
        reader.onload = (e) => {
          const textContent = (e.target?.result as string) || '';
          this.ngZone.run(() => {
            this.attachedFiles.push({
              name: file.name,
              size: file.size,
              type: file.type || 'text/plain',
              extension,
              content: textContent
            });
            this.cdr.detectChanges();
          });
        };
        reader.readAsText(file);
      } else {
        reader.onload = async (e) => {
          const dataUrl = (e.target?.result as string) || '';
          const ocrText = await this.extractImageTextWithOCR(dataUrl);
          this.ngZone.run(() => {
            this.attachedFiles.push({
              name: file.name,
              size: file.size,
              type: file.type || 'application/octet-stream',
              extension,
              content: ocrText ? `[Extracted Image Text (OCR)]:\n${ocrText}` : dataUrl,
              dataUrl
            });
            this.cdr.detectChanges();
          });
        };
        reader.readAsDataURL(file);
      }
    });

    input.value = '';
  }

  removeAttachedFile(index: number): void {
    this.attachedFiles.splice(index, 1);
    this.cdr.detectChanges();
  }

  formatFileSize(bytes: number): string {
    if (bytes < 1024) return bytes + ' B';
    if (bytes < 1024 * 1024) return (bytes / 1024).toFixed(1) + ' KB';
    return (bytes / (1024 * 1024)).toFixed(1) + ' MB';
  }

  // ── Right Side Document & Code Preview Panel ────────────────
  previewFile: { name: string; content: string; language: string } | null = null;

  openPreview(name: string, content: string, language?: string): void {
    this.previewFile = {
      name,
      content,
      language: language || (name.split('.').pop() || 'code')
    };
    this.cdr.detectChanges();
  }

  closePreview(): void {
    this.previewFile = null;
    this.cdr.detectChanges();
  }

  downloadFile(name: string, content: string): void {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = name;
    a.click();
    URL.revokeObjectURL(url);
  }

  downloadPreviewFile(): void {
    if (!this.previewFile) return;
    this.downloadFile(this.previewFile.name, this.previewFile.content);
  }

  renderMarkdown(content: string): SafeHtml {
    if (!content) return '';
    let text = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    if (!text && content.includes('<think>')) {
      return this.sanitizer.bypassSecurityTrustHtml('<span class="thinking-text-small">🧠 Thinking and generating response...</span>');
    }
    try {
      const parsedHtml = marked.parse(text) as string;
      return this.sanitizer.bypassSecurityTrustHtml(parsedHtml);
    } catch (e) {
      return text;
    }
  }

  handleMarkdownClick(event: MouseEvent): void {
    const target = event.target as HTMLElement;

    // 1. Copy code button
    const copyBtn = target.closest('.code-copy-btn') as HTMLButtonElement;
    if (copyBtn) {
      event.preventDefault();
      event.stopPropagation();
      const rawCode = decodeURIComponent(copyBtn.getAttribute('data-code') || '');
      if (rawCode) {
        navigator.clipboard.writeText(rawCode).then(() => {
          const originalText = copyBtn.innerHTML;
          copyBtn.innerHTML = '✅';
          setTimeout(() => {
            copyBtn.innerHTML = originalText;
            this.cdr.detectChanges();
          }, 2000);
        }).catch(err => console.error('Failed to copy code', err));
      }
      return;
    }

    // 2. Preview code button
    const previewBtn = target.closest('.btn-code-preview') as HTMLButtonElement;
    if (previewBtn) {
      event.preventDefault();
      event.stopPropagation();
      const rawCode = decodeURIComponent(previewBtn.getAttribute('data-preview-code') || '');
      const lang = previewBtn.getAttribute('data-lang') || 'code';
      if (rawCode) {
        const ext = lang === 'typescript' ? 'ts' : (lang === 'javascript' ? 'js' : (lang === 'python' ? 'py' : lang));
        this.openPreview(`document.${ext}`, rawCode, lang);
      }
      return;
    }

    // 3. Download code button
    const downloadBtn = target.closest('.btn-code-download') as HTMLButtonElement;
    if (downloadBtn) {
      event.preventDefault();
      event.stopPropagation();
      const rawCode = decodeURIComponent(downloadBtn.getAttribute('data-download-code') || '');
      const lang = downloadBtn.getAttribute('data-lang') || 'code';
      if (rawCode) {
        const ext = lang === 'typescript' ? 'ts' : (lang === 'javascript' ? 'js' : (lang === 'python' ? 'py' : (lang === 'html' ? 'html' : 'txt')));
        this.downloadFile(`code-export.${ext}`, rawCode);
      }
      return;
    }
  }

  copiedMsgIndex: number | null = null;

  copyMessageText(content: string, index: number): void {
    if (!content) return;
    const cleanText = content.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    navigator.clipboard.writeText(cleanText).then(() => {
      this.copiedMsgIndex = index;
      this.cdr.detectChanges();
      setTimeout(() => {
        if (this.copiedMsgIndex === index) {
          this.copiedMsgIndex = null;
          this.cdr.detectChanges();
        }
      }, 2000);
    }).catch(err => console.error('Failed to copy text', err));
  }

  // ── Send Message ───────────────────────────────────────────

  async sendMessage(): Promise<void> {
    if ((!this.userInput.trim() && this.attachedFiles.length === 0) || this.isGenerating) return;

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

  onPaste(event: ClipboardEvent): void {
    const items = event.clipboardData?.items;
    if (!items) return;

    for (let i = 0; i < items.length; i++) {
      const item = items[i];
      if (item.type.indexOf('image') !== -1) {
        const blob = item.getAsFile();
        if (blob) {
          event.preventDefault();
          const fileName = `screenshot_${Date.now()}.png`;
          const reader = new FileReader();
          reader.onload = (e) => {
            const dataUrl = (e.target?.result as string) || '';
            this.apiService.extractDocumentText(fileName, dataUrl).subscribe({
              next: (res) => {
                this.ngZone.run(() => {
                  this.attachedFiles.push({
                    name: fileName,
                    size: blob.size,
                    type: blob.type || 'image/png',
                    extension: 'png',
                    content: res.text || `[Screenshot: ${fileName}]`,
                    dataUrl
                  });
                  this.cdr.detectChanges();
                });
              },
              error: async () => {
                const ocrText = await this.extractImageTextWithOCR(dataUrl);
                this.ngZone.run(() => {
                  this.attachedFiles.push({
                    name: fileName,
                    size: blob.size,
                    type: blob.type || 'image/png',
                    extension: 'png',
                    content: ocrText ? `[Extracted Screenshot Text (OCR)]:\n${ocrText}` : dataUrl,
                    dataUrl
                  });
                  this.cdr.detectChanges();
                });
              }
            });
          };
          reader.readAsDataURL(blob);
        }
      }
    }
  }

  currentAbortController: AbortController | null = null;

  stopGeneration(): void {
    if (this.currentAbortController) {
      this.currentAbortController.abort();
      this.currentAbortController = null;
    }
    if (this.activeSessionId) {
      this.activeSessionStreams.delete(this.activeSessionId);
    }
    this.isGenerating = false;
    this.cdr.detectChanges();
  }

  private async executeSendMessage(): Promise<void> {
    const rawUserPrompt = this.userInput.trim();
    this.userInput = '';
    const currentSessionId = this.activeSessionId;

    const attachedSnapshots = this.attachedFiles.map(f => ({
      name: f.name,
      extension: f.extension,
      size: f.size,
      dataUrl: f.dataUrl
    }));

    const fileListToSend = this.attachedFiles.map(f => ({
      name: f.name,
      extension: f.extension,
      type: f.type,
      content: f.content,
      dataUrl: f.dataUrl
    }));

    let modelUserText = rawUserPrompt;

    if (this.attachedFiles.length > 0) {
      let fileContexts = '';
      this.attachedFiles.forEach((file) => {
        let textSample = file.content;
        if (textSample.startsWith('data:')) {
          textSample = `[Attached Image File: "${file.name}"]`;
        } else if (textSample.length > 20000) {
          textSample = textSample.slice(0, 20000) + `\n[... content truncated ...]`;
        }
        fileContexts += `\n[Extracted Text from File "${file.name}"]:\n${textSample}\n`;
      });
      modelUserText = rawUserPrompt ? `${fileContexts}\n[User Question]: ${rawUserPrompt}` : `${fileContexts}\nPlease analyze the document text above and answer the question.`;
      this.attachedFiles = [];
    }

    const activeSession = this.sessions.find((s) => s.id === this.activeSessionId);
    if (activeSession && (activeSession.title === 'New Conversation' || !activeSession.title)) {
      const titleText = rawUserPrompt || (attachedSnapshots[0]?.name ? `Attached: ${attachedSnapshots[0].name}` : 'File Analysis');
      activeSession.title = titleText.slice(0, 35) + (titleText.length > 35 ? '...' : '');
    }

    if (activeSession) {
      this.sessions = [activeSession, ...this.sessions.filter((s) => s.id !== activeSession.id)];
    }

    // Push clean user message to UI (without technical template wrappers)
    const displayMessage: ChatMessage = {
      role: 'user',
      content: rawUserPrompt || (attachedSnapshots.length > 0 ? `Attached ${attachedSnapshots.length} file(s)` : ''),
      attachments: attachedSnapshots.length > 0 ? attachedSnapshots : undefined
    };
    this.messages.push(displayMessage);
    this.scrollToBottom();

    this.isGenerating = true;
    this.currentStreamText = '';
    this.currentAbortController = new AbortController();

    const assistantMessage: ChatMessage = {
      role: 'assistant',
      content: '',
      modelId: this.selectedModelId,
      isLocal: this.selectedModelIsLocal
    };
    this.messages.push(assistantMessage);

    const streamState = {
      assistantMessage,
      fullText: '',
      isGenerating: true
    };

    if (currentSessionId) {
      this.activeSessionStreams.set(currentSessionId, streamState);
    }

    // Only pass RAG fields when local model is active and docs are indexed
    const useRag = this.ragActive && !!this.currentUser?.id;

    // Send payload to backend with modelUserText for current turn
    const apiMessages = this.messages.slice(0, -2).map(m => ({ role: m.role, content: m.content }));
    apiMessages.push({ role: 'user', content: modelUserText });

    const payload = {
      modelId: this.selectedModelId,
      messages: apiMessages,
      sessionId: this.activeSessionId || undefined,
      temperature: this.temperature,
      systemPrompt: this.systemPrompt,
      localServerUrl: this.localServerUrl,
      ragEnabled: useRag,
      userId: useRag ? (this.currentUser?.id || undefined) : undefined,
      selectedDocNames: useRag && this.selectedDocNames.size > 0 ? Array.from(this.selectedDocNames) : undefined,
      webSearchEnabled: this.webSearchEnabled,
      attachedFiles: fileListToSend.length > 0 ? fileListToSend : undefined,
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
        streamState.fullText += chunk;
        streamState.assistantMessage.content = streamState.fullText;

        if (this.activeSessionId === currentSessionId) {
          this.currentStreamText = streamState.fullText;
          this.scrollToBottom();
          this.cdr.detectChanges();
        }
      },
      (error: any) => {
        streamState.isGenerating = false;
        streamState.assistantMessage.content = `⚠️ Error: ${error.message || 'Failed to receive completion from AI provider.'}`;
        if (currentSessionId) {
          this.activeSessionStreams.delete(currentSessionId);
        }
        if (this.activeSessionId === currentSessionId) {
          this.isGenerating = false;
          this.currentAbortController = null;
          this.cdr.detectChanges();
        }
      },
      this.currentAbortController.signal
    );

    streamState.isGenerating = false;
    if (currentSessionId) {
      this.activeSessionStreams.delete(currentSessionId);
    }
    if (this.activeSessionId === currentSessionId) {
      this.isGenerating = false;
      this.cdr.detectChanges();
    }
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
