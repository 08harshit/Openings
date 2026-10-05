import { fetchAtsJobs } from './ats-clients';

describe('fetchAtsJobs externalId mapping', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
  });

  function mockJson(body: unknown): void {
    global.fetch = jest.fn().mockResolvedValue({ ok: true, json: async () => body } as Response);
  }

  it('maps a Greenhouse numeric id to a string externalId', async () => {
    mockJson({
      jobs: [
        {
          id: 4012345,
          title: 'Backend Engineer',
          absolute_url: 'https://boards.greenhouse.io/acme/jobs/4012345',
          location: { name: 'Bangalore' },
          departments: [{ name: 'Engineering' }],
        },
      ],
    });

    const jobs = await fetchAtsJobs('greenhouse', 'acme');

    expect(jobs[0].externalId).toBe('4012345');
  });

  it('maps a Lever id', async () => {
    mockJson([{ id: 'a1b2-c3d4', text: 'Backend Engineer', hostedUrl: 'https://jobs.lever.co/acme/a1b2-c3d4' }]);

    const jobs = await fetchAtsJobs('lever', 'acme');

    expect(jobs[0].externalId).toBe('a1b2-c3d4');
  });

  it('maps an Ashby id', async () => {
    mockJson({ jobs: [{ id: 'f00d-0001', title: 'Backend Engineer', jobUrl: 'https://jobs.ashbyhq.com/acme/f00d-0001' }] });

    const jobs = await fetchAtsJobs('ashby', 'acme');

    expect(jobs[0].externalId).toBe('f00d-0001');
  });

  it('uses null when the ATS omits an id', async () => {
    mockJson({ jobs: [{ title: 'Backend Engineer', absolute_url: 'https://boards.greenhouse.io/acme/jobs/1' }] });

    const jobs = await fetchAtsJobs('greenhouse', 'acme');

    expect(jobs[0].externalId).toBeNull();
  });
});
