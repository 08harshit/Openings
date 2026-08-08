import { DatePipe } from '@angular/common';
import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { ActivatedRoute, Router } from '@angular/router';
import { JOB_STATUS_LABELS, type JobDetail, type JobStatus } from '@jobportal/shared';
import { ApiService } from '../../core/api.service';
import { MatchBadgeComponent } from '../../shared/match-badge.component';
import { SkillChipsComponent } from '../../shared/skill-chips.component';
import { StatusSelectComponent } from '../../shared/status-select.component';

@Component({
  selector: 'app-job-detail',
  standalone: true,
  imports: [DatePipe, FormsModule, MatchBadgeComponent, SkillChipsComponent, StatusSelectComponent],
  templateUrl: './job-detail.component.html',
  styleUrl: './job-detail.component.css',
})
export class JobDetailComponent {
  private readonly route = inject(ActivatedRoute);
  private readonly router = inject(Router);
  private readonly api = inject(ApiService);

  readonly statusLabels = JOB_STATUS_LABELS;

  job = signal<JobDetail | null>(null);
  loading = signal(true);
  newNote = '';
  savingNote = signal(false);

  constructor() {
    const id = this.route.snapshot.paramMap.get('id');
    if (id) this.load(id);
  }

  private load(id: string): void {
    this.loading.set(true);
    this.api.getJob(id).subscribe({
      next: (job) => {
        this.job.set(job);
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  updateStatus(status: JobStatus): void {
    const job = this.job();
    if (!job) return;
    const previous = job.status;
    this.job.set({ ...job, status });
    this.api.updateJobStatus(job.id, status).subscribe({
      error: () => this.job.set({ ...job, status: previous }),
    });
  }

  addNote(): void {
    const job = this.job();
    const text = this.newNote.trim();
    if (!job || !text || this.savingNote()) return;

    this.savingNote.set(true);
    this.api.addNote(job.id, text).subscribe({
      next: (note) => {
        this.job.set({ ...job, notes: [note, ...job.notes], note_count: job.note_count + 1 });
        this.newNote = '';
        this.savingNote.set(false);
      },
      error: () => this.savingNote.set(false),
    });
  }

  deleteNote(noteId: string): void {
    const job = this.job();
    if (!job) return;
    this.api.deleteNote(job.id, noteId).subscribe(() => {
      this.job.set({
        ...job,
        notes: job.notes.filter((n) => n.id !== noteId),
        note_count: Math.max(0, job.note_count - 1),
      });
    });
  }

  deleteJob(): void {
    const job = this.job();
    if (!job || !confirm(`Remove "${job.title}" from your pipeline?`)) return;
    this.api.deleteJob(job.id).subscribe(() => void this.router.navigateByUrl('/dashboard'));
  }

  goBack(): void {
    void this.router.navigateByUrl('/dashboard');
  }
}
