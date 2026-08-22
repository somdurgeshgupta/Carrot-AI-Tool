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
  sourceId: string;
  reused?: boolean;
}

export interface IndexWebsiteResponse extends UploadDocumentResponse {
  sourceUrl: string;
  sourceId: string;
  reused?: boolean;
}

export interface IngestionJobResponse {
  id: string;
  status: 'QUEUED' | 'PROCESSING' | 'RETRYING' | 'COMPLETED' | 'FAILED' | 'CANCELLED';
  progress: number;
  errorMessage?: string | null;
  result?: (UploadDocumentResponse & { sourceUrl?: string }) | null;
}

@Injectable({
  providedIn: 'root',
})
export class RagService {
  private readonly baseUrl = `http://${window.location.hostname}:3000/api`;

  constructor(private http: HttpClient) {}

  private getAuthHeaders(): HttpHeaders {
    const token = localStorage.getItem('carrot_access_token');
    return new HttpHeaders({
      Authorization: token ? `Bearer ${token}` : '',
    });
  }

  uploadDocument(file: File): Observable<IngestionJobResponse | UploadDocumentResponse> {
    const formData = new FormData();
    formData.append('file', file, file.name);
    return this.http.post<IngestionJobResponse | UploadDocumentResponse>(
      `${this.baseUrl}/rag/upload`,
      formData,
      {
        headers: this.getAuthHeaders(),
      },
    );
  }

  indexWebsite(url: string): Observable<IngestionJobResponse | IndexWebsiteResponse> {
    return this.http.post<IngestionJobResponse | IndexWebsiteResponse>(
      `${this.baseUrl}/rag/website`,
      { url },
      { headers: this.getAuthHeaders() },
    );
  }

  getIngestionJob(jobId: string): Observable<IngestionJobResponse> {
    return this.http.get<IngestionJobResponse>(
      `${this.baseUrl}/rag/ingestion/${encodeURIComponent(jobId)}`,
      { headers: this.getAuthHeaders() },
    );
  }

  cancelIngestionJob(jobId: string): Observable<IngestionJobResponse> {
    return this.http.delete<IngestionJobResponse>(
      `${this.baseUrl}/rag/ingestion/${encodeURIComponent(jobId)}`,
      { headers: this.getAuthHeaders() },
    );
  }

  getDocuments(): Observable<UserDocumentSummary[]> {
    return this.http.get<UserDocumentSummary[]>(`${this.baseUrl}/rag/documents`, {
      headers: this.getAuthHeaders(),
    });
  }

  deleteDocument(fileName: string): Observable<{ success: boolean }> {
    return this.http.delete<{ success: boolean }>(
      `${this.baseUrl}/rag/documents/${encodeURIComponent(fileName)}`,
      { headers: this.getAuthHeaders() },
    );
  }
}
