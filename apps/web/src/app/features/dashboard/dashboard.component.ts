import { AfterViewChecked, Component, ElementRef, OnDestroy, ViewChild, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { interval, Subscription, switchMap } from 'rxjs';
import {
  KANBAN_STATUSES,
  JOB_STATUS_LABELS,
  SENIORITY_LEVELS,
  type IngestRunStatus,
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
export class DashboardComponent implements OnDestroy, AfterViewChecked {
  private readonly api = inject(ApiService);
  private readonly router = inject(Router);
  private pollSub: Subscription | null = null;

  @ViewChild('activityLog') private activityLogEl?: ElementRef<HTMLDivElement>;
  private activityLogLength = 0;

  readonly kanbanStatuses = KANBAN_STATUSES;
  readonly statusLabels = JOB_STATUS_LABELS;
  readonly seniorityLevels = SENIORITY_LEVELS;

  view = signal<ViewMode>('table');
  jobs = signal<JobListItem[]>([]);
  total = signal(0);
  loading = signal(false);
  refreshing = signal(false);
  refreshStatus = signal<IngestRunStatus | null>(null);
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
    // Pick up an already-running refresh (e.g. started before a page reload)
    // instead of leaving the dashboard with no indication one is in flight.
    this.api.ingestStatus().subscribe((status) => {
      if (status.state === 'running') {
        this.refreshing.set(true);
        this.refreshStatus.set(status);
        this.startPolling();
      }
    });
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

  /**
   * Starts a background ingestion run and polls for progress instead of
   * awaiting one multi-minute request — new jobs land in the DB company by
   * company, so each poll tick's `loadAll()` surfaces them as they're found
   * rather than only once the whole run finishes.
   */
  refresh(): void {
    if (this.refreshing()) return;
    this.refreshing.set(true);
    this.refreshStatus.set(null);

    this.api.refresh().subscribe({
      next: (status) => {
        this.refreshStatus.set(status);
        this.startPolling();
      },
      error: () => this.refreshing.set(false),
    });
  }

  private startPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = interval(3000)
      .pipe(switchMap(() => this.api.ingestStatus()))
      .subscribe({
        next: (status) => {
          this.refreshStatus.set(status);
          this.loadAll();
          if (status.state === 'done' || status.state === 'error') {
            this.stopPolling();
          }
        },
        error: () => this.stopPolling(),
      });
  }

  private stopPolling(): void {
    this.pollSub?.unsubscribe();
    this.pollSub = null;
    this.refreshing.set(false);
  }

  ngOnDestroy(): void {
    this.pollSub?.unsubscribe();
  }

  /** Keeps the activity log pinned to its latest line as new ones arrive,
   * the way a streaming chat log scrolls — without fighting the user if
   * they've scrolled up to read something earlier. */
  ngAfterViewChecked(): void {
    const el = this.activityLogEl?.nativeElement;
    const activity = this.refreshStatus()?.activity ?? [];
    if (!el || activity.length === this.activityLogLength) return;

    const wasNearBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 40;
    this.activityLogLength = activity.length;
    if (wasNearBottom) el.scrollTop = el.scrollHeight;
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
