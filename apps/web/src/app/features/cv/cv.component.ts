import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import {
  displaySkillName,
  PROFICIENCY_LEVELS,
  type CvProfile,
  type CvSkillDetail,
  type ProficiencyLevel,
  type Skill,
} from '@jobportal/shared';
import { ApiService } from '../../core/api.service';

@Component({
  selector: 'app-cv',
  standalone: true,
  imports: [FormsModule],
  templateUrl: './cv.component.html',
  styleUrl: './cv.component.css',
})
export class CvComponent {
  private readonly api = inject(ApiService);

  readonly proficiencyLevels = PROFICIENCY_LEVELS;
  readonly displaySkillName = displaySkillName;

  loading = signal(true);
  saving = signal(false);
  saved = signal(false);

  profile = signal<CvProfile | null>(null);
  skills = signal<CvSkillDetail[]>([]);
  allSkills = signal<Skill[]>([]);

  currentTitle = '';
  experienceYears: number | null = null;
  rawCvText = '';

  newSkillName = '';
  newSkillProficiency: ProficiencyLevel | '' = '';

  readonly groupedSkills = computed(() => {
    const groups = new Map<string, CvSkillDetail[]>();
    for (const skill of this.skills()) {
      const bucket = groups.get(skill.category) ?? [];
      bucket.push(skill);
      groups.set(skill.category, bucket);
    }
    return [...groups.entries()]
      .map(([category, items]) => ({ category, items }))
      .sort((a, b) => a.category.localeCompare(b.category));
  });

  readonly suggestions = computed(() => {
    const term = this.newSkillName.trim().toLowerCase();
    if (term.length < 1) return [];
    const have = new Set(this.skills().map((s) => s.name));
    return this.allSkills()
      .filter((s) => !have.has(s.name) && s.name.includes(term))
      .slice(0, 8);
  });

  constructor() {
    this.load();
    this.api.listAllSkills().subscribe((skills) => this.allSkills.set(skills));
  }

  private load(): void {
    this.loading.set(true);
    this.api.getCv().subscribe({
      next: ({ profile, skills }) => {
        this.profile.set(profile);
        this.skills.set(skills);
        this.currentTitle = profile.current_title ?? '';
        this.experienceYears = profile.experience_years;
        this.rawCvText = profile.raw_cv_text ?? '';
        this.loading.set(false);
      },
      error: () => this.loading.set(false),
    });
  }

  saveProfile(): void {
    this.saving.set(true);
    this.saved.set(false);
    this.api
      .updateCv({
        current_title: this.currentTitle.trim() || undefined,
        experience_years: this.experienceYears ?? undefined,
        raw_cv_text: this.rawCvText,
      })
      .subscribe({
        next: ({ profile }) => {
          this.profile.set(profile);
          this.saving.set(false);
          this.saved.set(true);
          setTimeout(() => this.saved.set(false), 2000);
        },
        error: () => this.saving.set(false),
      });
  }

  addSkill(name?: string): void {
    const skillName = (name ?? this.newSkillName).trim();
    if (!skillName) return;

    this.api
      .addCvSkill(skillName, this.newSkillProficiency || undefined)
      .subscribe((skills) => {
        this.skills.set(skills);
        this.newSkillName = '';
        this.newSkillProficiency = '';
      });
  }

  removeSkill(skillId: string): void {
    this.api.removeCvSkill(skillId).subscribe((skills) => this.skills.set(skills));
  }

  setProficiency(skill: CvSkillDetail, proficiency: ProficiencyLevel | ''): void {
    const value = proficiency || undefined;
    this.api.addCvSkill(skill.name, value).subscribe((skills) => this.skills.set(skills));
  }
}
