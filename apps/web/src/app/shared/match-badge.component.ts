import { Component, computed, input } from '@angular/core';
import { matchBand } from '@jobportal/shared';

/** Colour-coded match-score pill: green >75, yellow 50-75, red <50, grey unscored. */
@Component({
  selector: 'app-match-badge',
  standalone: true,
  template: `
    <span class="badge" [class]="'badge-' + band()">
      {{ score() === null || score() === undefined ? 'Unscored' : score() + '%' }}
    </span>
  `,
})
export class MatchBadgeComponent {
  score = input<number | null | undefined>(null);
  band = computed(() => matchBand(this.score()));
}
