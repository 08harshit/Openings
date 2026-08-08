import { Body, Controller, Delete, Get, Param, Patch, Post, Put } from '@nestjs/common';
import type { CvSkillDetail } from '@jobportal/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { CvService, type CvSnapshot } from './cv.service';
import { CvSkillDto, SetCvSkillsDto, UpdateCvDto } from './dto/cv.dto';

@Controller('cv')
export class CvController {
  constructor(private readonly cv: CvService) {}

  @Get()
  get(@CurrentUser('id') userId: string): Promise<CvSnapshot> {
    return this.cv.getSnapshot(userId);
  }

  @Patch()
  update(@CurrentUser('id') userId: string, @Body() dto: UpdateCvDto): Promise<CvSnapshot> {
    return this.cv.updateProfile(userId, dto);
  }

  /** Full replace — the editor always sends the complete desired skill set. */
  @Put('skills')
  setSkills(
    @CurrentUser('id') userId: string,
    @Body() dto: SetCvSkillsDto,
  ): Promise<CvSkillDetail[]> {
    return this.cv.setSkills(userId, dto.skills);
  }

  @Post('skills')
  addSkill(
    @CurrentUser('id') userId: string,
    @Body() dto: CvSkillDto,
  ): Promise<CvSkillDetail[]> {
    return this.cv.addSkill(userId, dto);
  }

  @Delete('skills/:skillId')
  removeSkill(
    @CurrentUser('id') userId: string,
    @Param('skillId') skillId: string,
  ): Promise<CvSkillDetail[]> {
    return this.cv.removeSkill(userId, skillId);
  }
}
