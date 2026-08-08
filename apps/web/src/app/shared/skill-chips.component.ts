import { Component, computed, input, output } from '@angular/core';

/** Clickable skill chips — used for both matched (neutral) and missing (red) skills. */
@Component({
  selector: 'app-skill-chips',
  standalone: true,
  template: `
    <div class="chips">
      @for (skill of visible(); track skill) {
        <button
          type="button"
          class="chip"
          [class.chip-missing]="variant() === 'missing'"
          (click)="chipClick.emit(skill)"
        >
          {{ skill }}
        </button>
      }
      @if (overflow() > 0) {
        <span class="chip chip-overflow">+{{ overflow() }}</span>
      }
      @if (visible().length === 0) {
        <span class="chip-empty">—</span>
      }
    </div>
  `,
  styles: [
    `
      .chips {
        display: flex;
        flex-wrap: wrap;
        gap: 4px;
      }
      .chip {
        border: 1px solid var(--color-border);
        cursor: pointer;
      }
      .chip:hover {
        filter: brightness(0.97);
      }
      .chip-overflow {
        display: inline-flex;
        align-items: center;
        padding: 2px 8px;
        border-radius: 999px;
        font-size: 11px;
        color: var(--color-text-muted);
      }
      .chip-empty {
        color: var(--color-text-muted);
        font-size: 12px;
      }
    `,
  ],
})
export class SkillChipsComponent {
  skills = input<string[]>([]);
  variant = input<'matched' | 'missing'>('matched');
  max = input<number>(6);
  chipClick = output<string>();

  visible = computed(() => this.skills().slice(0, this.max()));
  overflow = computed(() => Math.max(0, this.skills().length - this.max()));
}
