import { DecimalPipe } from '@angular/common';
import { Component, OnDestroy, OnInit, inject, signal } from '@angular/core';
import type { ApiUsageSnapshot } from '@jobportal/shared';
import { interval, Subscription, switchMap } from 'rxjs';
import { ApiService } from '../core/api.service';

/**
 * Remaining-quota readout for Firecrawl credits and Groq's per-minute token
 * budget, so a refresh running low on either doesn't fail silently mid-run.
 * Polls on a slow cadence — this is informational, not a live meter.
 */
@Component({
  selector: 'app-usage-badge',
  standalone: true,
  imports: [DecimalPipe],
  template: `
    @if (usage(); as u) {
      <div class="usage-badge">
        @if (u.firecrawl; as fc) {
          <span
            class="usage-pill"
            [class.usage-low]="isLow(fc.remaining_credits, fc.plan_credits)"
            title="Firecrawl credits remaining"
          >
            FC {{ fc.remaining_credits | number }}
            @if (fc.plan_credits) {
              / {{ fc.plan_credits | number }}
            }
          </span>
        }
        @if (u.groq; as groq) {
          <span
            class="usage-pill"
            [class.usage-low]="isLow(groq.remaining_requests, groq.limit_requests)"
            title="Groq requests remaining (resets {{ groq.reset_requests }})"
          >
            Groq {{ groq.remaining_requests | number }}
            @if (groq.limit_requests) {
              / {{ groq.limit_requests | number }}
            }
            req
          </span>
        }
        @if (!u.firecrawl && !u.groq) {
          <span class="usage-pill usage-muted">No usage data yet</span>
        }
      </div>
    }
  `,
  styles: [
    `
      .usage-badge {
        display: flex;
        gap: 6px;
        align-items: center;
      }
      .usage-pill {
        font-size: 11.5px;
        font-weight: 600;
        padding: 3px 8px;
        border-radius: 999px;
        background: var(--color-bg);
        color: var(--color-text-muted);
        border: 1px solid var(--color-border);
        white-space: nowrap;
      }
      .usage-pill.usage-low {
        background: #fef2f2;
        color: #b91c1c;
        border-color: #fecaca;
      }
      .usage-pill.usage-muted {
        opacity: 0.6;
      }
    `,
  ],
})
export class UsageBadgeComponent implements OnInit, OnDestroy {
  private readonly api = inject(ApiService);
  private sub: Subscription | null = null;

  usage = signal<ApiUsageSnapshot | null>(null);

  ngOnInit(): void {
    this.sub = interval(60_000)
      .pipe(switchMap(() => this.api.getUsage()))
      .subscribe((u) => this.usage.set(u));
    this.api.getUsage().subscribe((u) => this.usage.set(u));
  }

  ngOnDestroy(): void {
    this.sub?.unsubscribe();
  }

  /** Flag under 10% remaining, or a bare 0 limit (nothing reported yet). */
  isLow(remaining: number | null, limit: number | null): boolean {
    if (remaining === null || !limit) return false;
    return remaining / limit < 0.1;
  }
}
