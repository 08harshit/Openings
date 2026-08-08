import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ApiService } from '../../core/api.service';

/** "Manual Add job" — bypasses the scraper, inserts directly (plan feature 7). */
@Component({
  selector: 'app-add-job-dialog',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './add-job-dialog.component.html',
  styleUrl: './add-job-dialog.component.css',
})
export class AddJobDialogComponent {
  private readonly api = inject(ApiService);

  closed = output<void>();
  created = output<void>();

  title = '';
  companyName = '';
  location = '';
  url = '';
  descriptionRaw = '';

  saving = signal(false);
  error = signal<string | null>(null);

  get canSave(): boolean {
    return this.title.trim().length > 1 && this.url.trim().length > 3;
  }

  save(): void {
    if (!this.canSave || this.saving()) return;
    this.saving.set(true);
    this.error.set(null);

    this.api
      .createJob({
        title: this.title.trim(),
        url: this.url.trim(),
        company_name: this.companyName.trim() || undefined,
        location: this.location.trim() || undefined,
        description_raw: this.descriptionRaw.trim() || undefined,
      })
      .subscribe({
        next: () => {
          this.saving.set(false);
          this.created.emit();
        },
        error: (err) => {
          this.saving.set(false);
          this.error.set(err?.error?.message ?? 'Could not save job. Check the URL and try again.');
        },
      });
  }
}
