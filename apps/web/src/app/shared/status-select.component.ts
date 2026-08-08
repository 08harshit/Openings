import { Component, input, output } from '@angular/core';
import { JOB_STATUSES, JOB_STATUS_LABELS, type JobStatus } from '@jobportal/shared';

@Component({
  selector: 'app-status-select',
  standalone: true,
  template: `
    <select
      class="input status-select"
      [value]="status()"
      (change)="onChange($event)"
      (click)="$event.stopPropagation()"
    >
      @for (s of statuses; track s) {
        <option [value]="s">{{ labels[s] }}</option>
      }
    </select>
  `,
  styles: [
    `
      .status-select {
        width: auto;
        padding: 4px 8px;
        font-size: 12.5px;
      }
    `,
  ],
})
export class StatusSelectComponent {
  status = input.required<JobStatus>();
  statusChange = output<JobStatus>();

  readonly statuses = JOB_STATUSES;
  readonly labels = JOB_STATUS_LABELS;

  onChange(event: Event): void {
    const value = (event.target as HTMLSelectElement).value as JobStatus;
    this.statusChange.emit(value);
  }
}
