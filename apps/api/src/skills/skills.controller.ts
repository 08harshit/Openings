import { Controller, Get } from '@nestjs/common';
import type { Skill } from '@jobportal/shared';
import { SkillsService } from './skills.service';

@Controller('skills')
export class SkillsController {
  constructor(private readonly skills: SkillsService) {}

  /** Powers the autocomplete in the CV/skills editor. */
  @Get()
  listAll(): Promise<Skill[]> {
    return this.skills.listAll();
  }
}
