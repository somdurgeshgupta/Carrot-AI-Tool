import { Injectable } from '@angular/core';
import { HttpClient, HttpHeaders } from '@angular/common/http';
import { Observable } from 'rxjs';

export interface UserDocumentSummary {
  fileName: string;
  fileType: string;
  chunkCount: number;
  createdAt: string;
}

export interface UploadDocumentResponse {
  fileName: string;
  chunkCount: number;
}

@Injectable({
  providedIn: 'root'
})
export class RagService {
  private readonly baseUrl = `http://${window.location.hostname}:3000/api`;

  constructor(private http: HttpClient) {}

  private getAuthHeaders(): HttpHeaders {
    const token = localStorage.getItem('carrot_access_token');
    return new HttpHeaders({
      Authorization: token ? `Bearer ${token}` : ''
    });
  }

  uploadDocument(file: File): Observable<UploadDocumentResponse> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return this.http.post<UploadDocumentResponse>(
      `${this.baseUrl}/rag/upload`,
      formData,
      { headers: this.getAuthHeaders() }
    );
  }

  getDocuments(): Observable<UserDocumentSummary[]> {
    return this.http.get<UserDocumentSummary[]>(
      `${this.baseUrl}/rag/documents`,
      { headers: this.getAuthHeaders() }
    );
  }

  deleteDocument(fileName: string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(
      `${this.baseUrl}/rag/documents/${encodeURIComponent(fileName)}`,
      { headers: this.getAuthHeaders() }
    );
  }
}
