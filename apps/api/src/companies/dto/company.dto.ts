import { IsIn, IsOptional, IsString, IsUrl, MaxLength } from 'class-validator';
import { COMPANY_SOURCES, type CompanySource } from '@jobportal/shared';

export class CreateCompanyDto {
  @IsString()
  @MaxLength(200)
  name!: string;

  @IsOptional()
  @IsUrl({ require_protocol: false })
  @MaxLength(500)
  careers_url?: string;

  /** Defaults to `pinned` — anything created through the UI is deliberate. */
  @IsOptional()
  @IsIn(COMPANY_SOURCES)
  source?: CompanySource;
}

export class UpdateCompanyDto {
  @IsOptional()
  @IsString()
  @MaxLength(200)
  name?: string;

  @IsOptional()
  @IsString()
  @MaxLength(500)
  careers_url?: string;

  @IsOptional()
  @IsIn(COMPANY_SOURCES)
  source?: CompanySource;
}
