import { Global, Module } from '@nestjs/common';
import { SupabaseService } from './supabase.service';

/**
 * Global so feature modules can inject SupabaseService without each one
 * re-importing this module. There is exactly one database connection story in
 * this app; making it ambient is the honest modelling.
 */
@Global()
@Module({
  providers: [SupabaseService],
  exports: [SupabaseService],
})
export class SupabaseModule {}
