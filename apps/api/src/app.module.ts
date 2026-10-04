import { Module } from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import { ConfigModule } from '@nestjs/config';
import configuration from './config/configuration';
import { SupabaseModule } from './supabase/supabase.module';
import { AuthModule } from './auth/auth.module';
import { AuthGuard } from './auth/auth.guard';
import { SkillsModule } from './skills/skills.module';
import { CvModule } from './cv/cv.module';
import { CompaniesModule } from './companies/companies.module';
import { JobsModule } from './jobs/jobs.module';
import { FirecrawlModule } from './firecrawl/firecrawl.module';
import { AnalysisModule } from './analysis/analysis.module';
import { IngestModule } from './ingest/ingest.module';
import { UsageModule } from './usage/usage.module';
import { HealthController } from './health/health.controller';

@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    SupabaseModule,
    AuthModule,
    SkillsModule,
    CvModule,
    CompaniesModule,
    JobsModule,
    FirecrawlModule,
    AnalysisModule,
    IngestModule,
    UsageModule,
  ],
  controllers: [HealthController],
  providers: [{ provide: APP_GUARD, useClass: AuthGuard }],
})
export class AppModule {}
