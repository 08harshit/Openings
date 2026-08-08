import { Module } from '@nestjs/common';
import { CvModule } from '../cv/cv.module';
import { AnalysisService } from './analysis.service';

@Module({
  imports: [CvModule],
  providers: [AnalysisService],
  exports: [AnalysisService],
})
export class AnalysisModule {}
