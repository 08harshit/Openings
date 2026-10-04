import { Module } from '@nestjs/common';
import { FirecrawlModule } from '../firecrawl/firecrawl.module';
import { AnalysisModule } from '../analysis/analysis.module';
import { UsageController } from './usage.controller';

@Module({
  imports: [FirecrawlModule, AnalysisModule],
  controllers: [UsageController],
})
export class UsageModule {}
