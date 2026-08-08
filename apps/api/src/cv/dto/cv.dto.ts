import { Type } from 'class-transformer';
import {
  IsArray,
  IsIn,
  IsNumber,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  ValidateNested,
} from 'class-validator';
import { PROFICIENCY_LEVELS, type ProficiencyLevel } from '@jobportal/shared';

export class UpdateCvDto {
  @IsOptional()
  @IsString()
  @MaxLength(60_000)
  raw_cv_text?: string;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(60)
  experience_years?: number;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  current_title?: string;
}

export class CvSkillDto {
  /** Free text — normalised to a canonical slug server-side. */
  @IsString()
  @MaxLength(80)
  name!: string;

  @IsOptional()
  @IsIn(PROFICIENCY_LEVELS)
  proficiency?: ProficiencyLevel;
}

export class SetCvSkillsDto {
  @IsArray()
  @ValidateNested({ each: true })
  @Type(() => CvSkillDto)
  skills!: CvSkillDto[];
}
