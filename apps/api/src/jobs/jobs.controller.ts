import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpStatus,
  Param,
  Patch,
  Post,
  Query,
} from '@nestjs/common';
import type {
  ApplicationNote,
  JobDetail,
  JobListItem,
  JobPosting,
  Paginated,
} from '@jobportal/shared';
import { CurrentUser } from '../auth/current-user.decorator';
import { JobsService } from './jobs.service';
import { CreateJobDto, CreateNoteDto, ListJobsQueryDto, UpdateJobStatusDto } from './dto/job.dto';

@Controller('jobs')
export class JobsController {
  constructor(private readonly jobs: JobsService) {}

  @Get()
  list(
    @CurrentUser('id') userId: string,
    @Query() query: ListJobsQueryDto,
  ): Promise<Paginated<JobListItem>> {
    return this.jobs.list(userId, query);
  }

  @Get('stats')
  stats(@CurrentUser('id') userId: string) {
    return this.jobs.stats(userId);
  }

  @Get(':id')
  findOne(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<JobDetail> {
    return this.jobs.findOne(userId, id);
  }

  @Post()
  create(@CurrentUser('id') userId: string, @Body() dto: CreateJobDto): Promise<JobPosting> {
    return this.jobs.create(userId, dto);
  }

  @Patch(':id/status')
  updateStatus(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: UpdateJobStatusDto,
  ): Promise<JobPosting> {
    return this.jobs.updateStatus(userId, id, dto.status);
  }

  @Delete(':id')
  @HttpCode(HttpStatus.NO_CONTENT)
  remove(@CurrentUser('id') userId: string, @Param('id') id: string): Promise<void> {
    return this.jobs.remove(userId, id);
  }

  @Post(':id/notes')
  addNote(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Body() dto: CreateNoteDto,
  ): Promise<ApplicationNote> {
    return this.jobs.addNote(userId, id, dto.note_text);
  }

  @Delete(':id/notes/:noteId')
  @HttpCode(HttpStatus.NO_CONTENT)
  removeNote(
    @CurrentUser('id') userId: string,
    @Param('id') id: string,
    @Param('noteId') noteId: string,
  ): Promise<void> {
    return this.jobs.removeNote(userId, id, noteId);
  }
}
