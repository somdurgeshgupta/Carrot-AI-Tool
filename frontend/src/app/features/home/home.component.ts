import { Component, OnInit } from '@angular/core';
import { ApiService, HealthStatus } from '../../core/services/api.service';

@Component({
  selector: 'app-home',
  templateUrl: './home.component.html',
  styleUrls: ['./home.component.css'],
  standalone: false
})
export class HomeComponent implements OnInit {
  welcomeMessage = 'Angular (NgModule CSR) + NestJS Backend Setup';
  apiStatus: HealthStatus | null = null;
  loading = true;

  constructor(private apiService: ApiService) {}

  ngOnInit(): void {
    this.apiService.getHealthStatus().subscribe({
      next: (status) => {
        this.apiStatus = status;
        this.loading = false;
      },
      error: () => {
        this.loading = false;
      }
    });
  }
}
