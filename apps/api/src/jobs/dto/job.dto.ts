import { Transform, Type } from 'class-transformer';
import {
  IsArray,
  IsBoolean,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  IsUrl,
  Max,
  MaxLength,
  Min,
  MinLength,
} from 'class-validator';
import {
  JOB_STATUSES,
  SENIORITY_LEVELS,
  type JobStatus,
  type SeniorityLevel,
} from '@jobportal/shared';

export class CreateJobDto {
  @IsString()
  @MinLength(2)
  @MaxLength(300)
  title!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  company_name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(100)
  company_id?: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  location?: string;

  @IsUrl({ require_protocol: false })
  @MaxLength(2000)
  url!: string;

  @IsOptional()
  @IsString()
  @MaxLength(40_000)
  description_raw?: string;

  @IsOptional()
  @IsIn(SENIORITY_LEVELS)
  seniority_guess?: SeniorityLevel;

  /** ISO date string (yyyy-mm-dd) or full timestamp — either is fine. */
  @IsOptional()
  @IsString()
  posted_date?: string;
}

export class UpdateJobStatusDto {
  @IsIn(JOB_STATUSES)
  status!: JobStatus;
}

export class CreateNoteDto {
  @IsString()
  @MinLength(1)
  @MaxLength(10_000)
  note_text!: string;
}

export class ListJobsQueryDto {
  @IsOptional()
  @IsArray()
  @IsIn(JOB_STATUSES, { each: true })
  @Type(() => String)
  status?: JobStatus[];

  @IsOptional()
  @IsString()
  @MaxLength(200)
  search?: string;

  @IsOptional()
  @IsString()
  company_id?: string;

  @IsOptional()
  @IsIn(SENIORITY_LEVELS)
  seniority?: SeniorityLevel;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  min_score?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(0)
  @Max(100)
  max_score?: number;

  @IsOptional()
  @IsString()
  @MaxLength(80)
  missing_skill?: string;

  // Query params arrive as strings. class-transformer's @Type(() => Boolean)
  // just calls Boolean(value), so "false" (a non-empty string) becomes `true`
  // — parse "true"/"false" explicitly instead.
  @IsOptional()
  @Transform(({ value }) => parseBooleanQueryParam(value))
  @IsBoolean()
  stale_only?: boolean;

  @IsOptional()
  @Transform(({ value }) => parseBooleanQueryParam(value))
  @IsBoolean()
  unscored_only?: boolean;

  @IsOptional()
  @IsIn(['final_score', 'match_score', 'scraped_at', 'posted_date', 'title'])
  sort?: 'final_score' | 'match_score' | 'scraped_at' | 'posted_date' | 'title';

  @IsOptional()
  @IsIn(['asc', 'desc'])
  direction?: 'asc' | 'desc';

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  page?: number;

  @IsOptional()
  @Type(() => Number)
  @IsInt()
  @Min(1)
  @Max(200)
  page_size?: number;
}

/** Boolean values that reach the DTO are query-string values ("true"/"false")
 * or already-boolean (when constructed in code, e.g. tests). */
function parseBooleanQueryParam(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
