import { HttpClient, HttpParams } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import type { Observable } from 'rxjs';
import type {
  ApiUsageSnapshot,
  ApplicationNote,
  Company,
  CompanySource,
  CvProfile,
  CvSkillDetail,
  IngestRunStatus,
  JobDetail,
  JobListItem,
  JobPosting,
  JobQuery,
  JobStatus,
  Paginated,
  ProficiencyLevel,
  Skill,
} from '@jobportal/shared';
import { environment } from '../../environments/environment';

export interface CvSnapshot {
  profile: CvProfile;
  skills: CvSkillDetail[];
}

/** Mirrors JobsService.stats() on the API — a subset of the shared
 * DashboardStats type (no top_missing_skills; the backend doesn't compute
 * that aggregate yet). */
export interface JobStatsResponse {
  total: number;
  by_status: Record<JobStatus, number>;
  stale_count: number;
  unscored_count: number;
  average_match_score: number | null;
}

/**
 * Single point of contact with the NestJS API. Every endpoint in
 * apps/api/src/*.controller.ts has a matching method here — components never
 * call HttpClient directly.
 */
@Injectable({ providedIn: 'root' })
export class ApiService {
  private readonly http = inject(HttpClient);
  private readonly base = environment.apiBaseUrl;

  // --- Jobs ------------------------------------------------------------
  listJobs(query: JobQuery): Observable<Paginated<JobListItem>> {
    let params = new HttpParams();
    for (const [key, value] of Object.entries(query)) {
      if (value === undefined || value === null || value === '') continue;
      if (Array.isArray(value)) {
        for (const v of value) params = params.append(key, String(v));
      } else {
        params = params.set(key, String(value));
      }
    }
    return this.http.get<Paginated<JobListItem>>(`${this.base}/jobs`, { params });
  }

  jobStats(): Observable<JobStatsResponse> {
    return this.http.get<JobStatsResponse>(`${this.base}/jobs/stats`);
  }

  getJob(id: string): Observable<JobDetail> {
    return this.http.get<JobDetail>(`${this.base}/jobs/${id}`);
  }

  createJob(dto: {
    title: string;
    url: string;
    company_name?: string;
    company_id?: string;
    location?: string;
    description_raw?: string;
    posted_date?: string;
  }): Observable<JobPosting> {
    return this.http.post<JobPosting>(`${this.base}/jobs`, dto);
  }

  updateJobStatus(id: string, status: JobStatus): Observable<JobPosting> {
    return this.http.patch<JobPosting>(`${this.base}/jobs/${id}/status`, { status });
  }

  deleteJob(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/jobs/${id}`);
  }

  addNote(jobId: string, noteText: string): Observable<ApplicationNote> {
    return this.http.post<ApplicationNote>(`${this.base}/jobs/${jobId}/notes`, {
      note_text: noteText,
    });
  }

  deleteNote(jobId: string, noteId: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/jobs/${jobId}/notes/${noteId}`);
  }

  // --- Companies ---------------------------------------------------------
  listCompanies(source?: CompanySource): Observable<Company[]> {
    const params = source ? new HttpParams().set('source', source) : undefined;
    return this.http.get<Company[]>(`${this.base}/companies`, { params });
  }

  createCompany(dto: { name: string; careers_url?: string; source?: CompanySource }): Observable<Company> {
    return this.http.post<Company>(`${this.base}/companies`, dto);
  }

  updateCompany(
    id: string,
    dto: { name?: string; careers_url?: string; source?: CompanySource },
  ): Observable<Company> {
    return this.http.patch<Company>(`${this.base}/companies/${id}`, dto);
  }

  deleteCompany(id: string): Observable<void> {
    return this.http.delete<void>(`${this.base}/companies/${id}`);
  }

  // --- CV / skills ---------------------------------------------------------
  getCv(): Observable<CvSnapshot> {
    return this.http.get<CvSnapshot>(`${this.base}/cv`);
  }

  updateCv(dto: {
    raw_cv_text?: string;
    experience_years?: number;
    current_title?: string;
  }): Observable<CvSnapshot> {
    return this.http.patch<CvSnapshot>(`${this.base}/cv`, dto);
  }

  setCvSkills(
    skills: Array<{ name: string; proficiency?: ProficiencyLevel }>,
  ): Observable<CvSkillDetail[]> {
    return this.http.put<CvSkillDetail[]>(`${this.base}/cv/skills`, { skills });
  }

  addCvSkill(name: string, proficiency?: ProficiencyLevel): Observable<CvSkillDetail[]> {
    return this.http.post<CvSkillDetail[]>(`${this.base}/cv/skills`, { name, proficiency });
  }

  removeCvSkill(skillId: string): Observable<CvSkillDetail[]> {
    return this.http.delete<CvSkillDetail[]>(`${this.base}/cv/skills/${skillId}`);
  }

  listAllSkills(): Observable<Skill[]> {
    return this.http.get<Skill[]>(`${this.base}/skills`);
  }

  // --- Ingestion ---------------------------------------------------------
  /** Starts a background run; returns immediately with its initial status. */
  refresh(): Observable<IngestRunStatus> {
    return this.http.post<IngestRunStatus>(`${this.base}/ingest/refresh`, {});
  }

  ingestStatus(): Observable<IngestRunStatus> {
    return this.http.get<IngestRunStatus>(`${this.base}/ingest/status`);
  }

  // --- Usage / quota -------------------------------------------------------
  getUsage(): Observable<ApiUsageSnapshot> {
    return this.http.get<ApiUsageSnapshot>(`${this.base}/usage`);
  }
}
