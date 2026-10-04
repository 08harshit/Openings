import { CvService } from './cv.service';
import { SkillsService } from '../skills/skills.service';
import { SupabaseService } from '../supabase/supabase.service';

describe('CvService.updateProfile', () => {
  function makeFakeSupabase(initialProfile: Record<string, unknown>) {
    let storedProfile = { ...initialProfile };

    const fromCvProfile = {
      select: () => fromCvProfile,
      eq: () => fromCvProfile,
      maybeSingle: async () => ({ data: storedProfile, error: null }),
      update: (patch: Record<string, unknown>) => {
        storedProfile = { ...storedProfile, ...patch };
        return {
          eq: () => ({
            eq: () => ({
              select: () => ({
                single: async () => ({ data: storedProfile, error: null }),
              }),
            }),
          }),
        };
      },
    };

    const fromCvSkills = {
      select: () => fromCvSkills,
      eq: () => ({ data: [], error: null }),
    };

    const admin = {
      from: (table: string) => {
        if (table === 'cv_profile') return fromCvProfile;
        if (table === 'cv_skills') return fromCvSkills;
        throw new Error(`unexpected table in test fake: ${table}`);
      },
    };

    const fakeSupabase = {
      admin,
      unwrap: (result: { data: unknown; error: unknown }) => result.data,
      unwrapMaybe: (result: { data: unknown; error: unknown }) => result.data,
    } as unknown as SupabaseService;

    return { fakeSupabase, getStoredProfile: () => storedProfile };
  }

  it('does not clobber unrelated array fields on a partial update', async () => {
    const { fakeSupabase, getStoredProfile } = makeFakeSupabase({
      id: 'profile-1',
      user_id: 'user-1',
      target_roles: ['backend'],
      excluded_companies: ['Acme'],
      preferred_locations: ['india'],
    });
    const fakeSkills = {} as SkillsService;
    const service = new CvService(fakeSupabase, fakeSkills);

    await service.updateProfile('user-1', { target_roles: ['backend', 'full stack'] });

    const stored = getStoredProfile();
    expect(stored.target_roles).toEqual(['backend', 'full stack']);
    expect(stored.excluded_companies).toEqual(['Acme']);
    expect(stored.preferred_locations).toEqual(['india']);
  });
});
