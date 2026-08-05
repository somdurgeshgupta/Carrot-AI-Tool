import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';
import { Observable, catchError, of } from 'rxjs';

export interface HealthStatus {
  status: string;
  timestamp: string;
  service: string;
  version: string;
}

@Injectable({
  providedIn: 'root'
})
export class ApiService {
  private readonly baseUrl = 'http://localhost:3000/api';

  constructor(private http: HttpClient) {}

  getHealthStatus(): Observable<HealthStatus | null> {
    return this.http.get<HealthStatus>(`${this.baseUrl}/health`).pipe(
      catchError((error) => {
        console.error('API connection error:', error);
        return of(null);
      })
    );
  }
}
