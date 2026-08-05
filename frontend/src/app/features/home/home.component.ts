import { Component, OnInit } from '@angular/core';
import { ApiService, HealthCheckResponse } from '../../core/services/api.service';

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.css'],
  standalone: false
})
export class HomeComponent implements OnInit {
  welcomeMessage = 'Carrot AI Hybrid Platform';
  apiStatus: HealthCheckResponse | null = null;
  loading = true;

  constructor(private apiService: ApiService) {}

  ngOnInit(): void {
    this.apiService.checkHealth().subscribe({
      next: (status: HealthCheckResponse) => {
        this.apiStatus = status;
        this.loading = false;
      },
      error: () => {
        this.loading = false;
      }
    });
  }
}
