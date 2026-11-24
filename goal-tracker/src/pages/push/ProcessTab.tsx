import { ListChecks, Workflow } from 'lucide-react';
import { useLocal } from '../../lib/hooks.ts';
import { setQuery, useQuery } from '../../lib/router.tsx';
import { Chip } from '../../ui/kit.tsx';
import type { PushScope } from '../PushPage.tsx';
import { ChainsTab } from './ChainsTab.tsx';
import { JobList } from './JobsTab.tsx';

/**
 * Everything that happens to materials once they are in storage, seen two ways:
 * as a list of jobs (what can be collected or crafted right now), or as the full
 * picture (each raw material followed through everything it is turned into).
 */
export function ProcessTab({ scope }: { scope: PushScope }) {
  const [saved, setSaved] = useLocal<'jobs' | 'chains'>('qm.process.look', 'jobs');
  // "See the full picture" on a material lands here with ?chain=<that material>.
  const asked = useQuery().get('chain');
  const look = asked ? 'chains' : saved;
  const choose = (next: 'jobs' | 'chains') => {
    setSaved(next);
    if (asked) setQuery('chain', null);
  };
  return (
    <div>
      <div className="mb-3 flex items-center gap-2" role="group" aria-label="How to show processing">
        <Chip active={look !== 'chains'} onClick={() => choose('jobs')}>
          <ListChecks size={13} /> Jobs
        </Chip>
        <Chip active={look === 'chains'} onClick={() => choose('chains')}>
          <Workflow size={13} /> Full picture
        </Chip>
      </div>
      {look === 'chains' ? <ChainsTab scope={scope} /> : <JobList scope={scope} mode="process" />}
    </div>
  );
}
