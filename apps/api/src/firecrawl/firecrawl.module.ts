import { Module } from '@nestjs/common';
import { FirecrawlService } from './firecrawl.service';

@Module({
  providers: [FirecrawlService],
  exports: [FirecrawlService],
})
export class FirecrawlModule {}
