import { Module } from '@nestjs/common';
import { FirecrawlModule } from '../firecrawl/firecrawl.module';
import { CompanyResolverService } from './company-resolver.service';

@Module({
  imports: [FirecrawlModule],
  providers: [CompanyResolverService],
  exports: [CompanyResolverService],
})
export class DiscoveryModule {}
