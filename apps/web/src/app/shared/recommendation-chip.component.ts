import { Component, computed, input } from '@angular/core';
import type { Recommendation } from '@jobportal/shared';

const LABELS: Record<Recommendation, string> = {
  APPLY_NOW: 'Apply now',
  STRONG_MATCH: 'Strong match',
  CONSIDER: 'Consider',
  LOW_PRIORITY: 'Low priority',
  SKIP: 'Skip',
};

/** Colour-coded recommendation-band pill (final_score's band), distinct from
 * app-match-badge's raw percentage — renders nothing for an unanalyzed job
 * (null recommendation) rather than a placeholder/"Unscored" chip, since the
 * badge already covers that case. */
@Component({
  selector: 'app-recommendation-chip',
  standalone: true,
  template: `
    @if (recommendation(); as r) {
      <span class="badge" [class]="'badge-' + r.toLowerCase()">{{ label() }}</span>
    }
  `,
})
export class RecommendationChipComponent {
  recommendation = input<Recommendation | null | undefined>(null);
  label = computed(() => {
    const r = this.recommendation();
    return r ? LABELS[r] : '';
  });
}
