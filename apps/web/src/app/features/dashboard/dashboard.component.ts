import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import {
  KANBAN_STATUSES,
  JOB_STATUS_LABELS,
  SENIORITY_LEVELS,
  type IngestRunSummary,
  type JobListItem,
  type JobStatus,
  type SeniorityLevel,
} from '@jobportal/shared';
import { ApiService, type JobStatsResponse } from '../../core/api.service';
import { MatchBadgeComponent } from '../../shared/match-badge.component';
import { SkillChipsComponent } from '../../shared/skill-chips.component';
import { StatusSelectComponent } from '../../shared/status-select.component';
import { AddJobDialogComponent } from './add-job-dialog.component';

type ViewMode = 'table' | 'kanban';

@Component({
  selector: 'app-dashboard',
  standalone: true,
  imports: [FormsModule, MatchBadgeComponent, SkillChipsComponent, StatusSelectComponent, AddJobDialogComponent],
  templateUrl: './dashboard.component.html',
  styleUrl: './dashboard.component.css',
})
export class DashboardComponent {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);

  readonly kanbanStatuses = KANBAN_STATUSES;
  readonly statusLabels = JOB_STATUS_LABELS;
  readonly seniorityLevels = SENIORITY_LEVELS;

  view = signal<ViewMode>('table');
  jobs = signal<JobListItem[]>([]);
  total = signal(0);
  loading = signal(false);
  refreshing = signal(false);
  refreshSummary = signal<IngestRunSummary | null>(null);
  stats = signal<JobStatsResponse | null>(null);
  showAddJob = signal(false);
  dragOverStatus = signal<JobStatus | null>(null);

  // --- filters ---
  search = '';
  seniority: SeniorityLevel | '' = '';
  staleOnly = false;
  unscoredOnly = false;
  missingSkill = signal<string | null>(null);
  statusFilter = signal<JobStatus[]>([]);

  readonly kanbanColumns = computed(() => {
    const byStatus = new Map<JobStatus, JobListItem[]>();
    for (const status of this.kanbanStatuses) byStatus.set(status, []);
    for (const job of this.jobs()) {
      if (byStatus.has(job.status)) byStatus.get(job.status)!.push(job);
    }
    return this.kanbanStatuses.map((status) => ({ status, jobs: byStatus.get(status) ?? [] }));
  });

  constructor() {
    this.loadAll();
  }

  loadAll(): void {
    this.loadJobs();
    this.loadStats();
  }

  loadJobs(): void {
    this.loading.set(true);
    this.api
      .listJobs({
        search: this.search.trim() || undefined,
        seniority: this.seniority || undefined,
        stale_only: this.staleOnly || undefined,
        unscored_only: this.unscoredOnly || undefined,
        missing_skill: this.missingSkill() ?? undefined,
        status: this.statusFilter().length ? this.statusFilter() : undefined,
        sort: 'scraped_at',
        direction: 'desc',
        page: 1,
        page_size: 200,
      })
      .subscribe({
        next: (res) => {
          this.jobs.set(res.items);
          this.total.set(res.total);
          this.loading.set(false);
        },
        error: () => this.loading.set(false),
      });
  }

  loadStats(): void {
    this.api.jobStats().subscribe((s) => this.stats.set(s));
  }

  applyFilters(): void {
    this.loadJobs();
  }

  clearMissingSkillFilter(): void {
    this.missingSkill.set(null);
    this.loadJobs();
  }

  onMissingSkillClick(skill: string): void {
    this.missingSkill.set(skill);
    this.loadJobs();
  }

  toggleStatusFilter(status: JobStatus, checked: boolean): void {
    const current = new Set(this.statusFilter());
    if (checked) current.add(status);
    else current.delete(status);
    this.statusFilter.set([...current]);
    this.loadJobs();
  }

  refresh(): void {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    this.refreshSummary.set(null);
    this.api.refresh().subscribe({
      next: (summary) => {
        this.refreshing.set(false);
        this.refreshSummary.set(summary);
        this.loadAll();
      },
      error: () => this.refreshing.set(false),
    });
  }

  updateStatus(job: JobListItem, status: JobStatus): void {
    const previous = job.status;
    job.status = status; // optimistic
    this.api.updateJobStatus(job.id, status).subscribe({
      next: () => this.loadStats(),
      error: () => {
        job.status = previous;
      },
    });
  }

  openJob(id: string): void {
    void this.router.navigate(['/jobs', id]);
  }

  deleteJob(job: JobListItem, event: Event): void {
    event.stopPropagation();
    if (!confirm(`Remove "${job.title}" from your pipeline?`)) return;
    this.api.deleteJob(job.id).subscribe(() => {
      this.jobs.update((list) => list.filter((j) => j.id !== job.id));
      this.loadStats();
    });
  }

  onAddJobCreated(): void {
    this.showAddJob.set(false);
    this.loadAll();
  }

  // --- Kanban drag & drop (native HTML5 DnD — no extra dependency needed) ---
  onDragStart(event: DragEvent, job: JobListItem): void {
    event.dataTransfer?.setData('text/plain', job.id);
    event.dataTransfer!.effectAllowed = 'move';
  }

  onDragOver(event: DragEvent, status: JobStatus): void {
    event.preventDefault();
    this.dragOverStatus.set(status);
  }

  onDragLeave(): void {
    this.dragOverStatus.set(null);
  }

  onDrop(event: DragEvent, status: JobStatus): void {
    event.preventDefault();
    this.dragOverStatus.set(null);
    const jobId = event.dataTransfer?.getData('text/plain');
    const job = this.jobs().find((j) => j.id === jobId);
    if (job && job.status !== status) this.updateStatus(job, status);
  }
}
