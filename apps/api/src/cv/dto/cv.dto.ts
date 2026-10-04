import { Type } from 'class-transformer';
import {
  ArrayMaxSize,
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

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  target_roles?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  excluded_roles?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  excluded_departments?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  preferred_locations?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  excluded_companies?: string[];

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(60)
  seniority_min_years?: number;

  @IsOptional()
  @IsNumber({ maxDecimalPlaces: 1 })
  @Min(0)
  @Max(60)
  seniority_max_years?: number;

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  work_modes?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(10)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  employment_types?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  domain_preferences?: string[];

  @IsOptional()
  @IsArray()
  @ArrayMaxSize(50)
  @IsString({ each: true })
  @MaxLength(100, { each: true })
  domain_exclusions?: string[];
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
