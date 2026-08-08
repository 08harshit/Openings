import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { DatePipe } from '@angular/common';
import type { Company } from '@jobportal/shared';
import { ApiService } from '../../core/api.service';

@Component({
  selector: 'app-companies',
  standalone: true,
  imports: [FormsModule, DatePipe],
  templateUrl: './companies.component.html',
  styleUrl: './companies.component.css',
})
export class CompaniesComponent {
  private readonly api = inject(ApiService);

  companies = signal<Company[]>([]);
  loading = signal(true);

  newName = '';
  newCareersUrl = '';
  saving = signal(false);
  error = signal<string | null>(null);

  constructor() {
    this.load();
  }

  get pinned(): Company[] {
    return this.companies().filter((c) => c.source === 'pinned');
  }

  get discoveredResolved(): Company[] {
    return this.companies().filter((c) => c.source === 'auto_discovered' && c.resolution_status === 'resolved');
  }

  get discoveredFailed(): Company[] {
    return this.companies().filter((c) => c.source === 'auto_discovered' && c.resolution_status === 'failed');
  }

  get discoveredPending(): Company[] {
    return this.companies().filter((c) => c.source === 'auto_discovered' && c.resolution_status === 'pending');
  }

  load(): void {
    this.loading.set(true);
    this.api.listCompanies().subscribe({
      next: (list) => {
        this.companies.set(list);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  add(): void {
    const name = this.newName.trim();
    if (!name || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);

    this.api
      .createCompany({
        name,
        careers_url: this.newCareersUrl.trim() || undefined,
        source: 'pinned',
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.newName = '';
          this.newCareersUrl = '';
          this.load();
        },
        error: (err) => {
          this.saving.set(false);
          this.error.set(err?.error?.message ?? 'Could not add company.');
        },
      });
  }

  promote(company: Company): void {
    this.api.updateCompany(company.id, { source: 'pinned' }).subscribe(() => this.load());
  }

  remove(company: Company): void {
    if (!confirm(`Remove "${company.name}" from your pinned companies?`)) return;
    this.api.deleteCompany(company.id).subscribe(() => this.load());
  }
}
