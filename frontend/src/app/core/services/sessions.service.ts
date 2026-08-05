import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable } from 'rxjs';
import { ChatMessage } from './api.service';

export interface ChatSession {
  id: string;
  title: string;
  modelId: string;
  createdAt: string;
  updatedAt: string;
  messages?: ChatMessage[];
}

@Injectable({
  providedIn: 'root'
})
export class SessionsService {
  private readonly baseUrl = 'http://localhost:3000/api/sessions';

  constructor(private http: HttpClient) {}

  getSessions(): Observable<ChatSession[]> {
    return this.http.get<ChatSession[]>(this.baseUrl);
  }

  getSessionDetails(id: string): Observable<ChatSession> {
    return this.http.get<ChatSession>(`${this.baseUrl}/${id}`);
  }

  createSession(title?: string, modelId?: string): Observable<ChatSession> {
    return this.http.post<ChatSession>(this.baseUrl, { title, modelId });
  }

  updateSessionTitle(id: string, title: string): Observable<ChatSession> {
    return this.http.patch<ChatSession>(`${this.baseUrl}/${id}`, { title });
  }

  deleteSession(id: string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(`${this.baseUrl}/${id}`);
  }
}
