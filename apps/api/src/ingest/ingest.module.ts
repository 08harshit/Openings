import { Module } from '@nestjs/common';
import { ScheduleModule } from '@nestjs/schedule';
import { FirecrawlModule } from '../firecrawl/firecrawl.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { CompaniesModule } from '../companies/companies.module';
import { DiscoveryModule } from '../discovery/discovery.module';
import { IngestController } from './ingest.controller';
import { IngestService } from './ingest.service';
import { IngestScheduler } from './ingest.scheduler';

@Module({
  imports: [
    ScheduleModule.forRoot(),
    FirecrawlModule,
    AnalysisModule,
    CompaniesModule,
    DiscoveryModule,
  ],
  controllers: [IngestController],
  providers: [IngestService, IngestScheduler],
  exports: [IngestService],
})
export class IngestModule {}
