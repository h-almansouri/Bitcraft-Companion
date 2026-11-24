import { ListChecks, Workflow } from 'lucide-react';
import { useLocal } from '../../lib/hooks.ts';
import { Chip } from '../../ui/kit.tsx';
import type { PushScope } from '../PushPage.tsx';
import { ChainsTab } from './ChainsTab.tsx';
import { JobList } from './JobsTab.tsx';

/**
 * Everything that happens to materials once they are in storage, seen two ways:
 * as a list of jobs (what can be collected or crafted right now), or as chains
 * (each raw material followed through everything it is turned into).
 */
export function ProcessTab({ scope }: { scope: PushScope }) {
  const [look, setLook] = useLocal<'jobs' | 'chains'>('qm.process.look', 'jobs');
  return (
    <div>
      <div className="mb-3 flex items-center gap-2" role="group" aria-label="How to show processing">
        <Chip active={look !== 'chains'} onClick={() => setLook('jobs')}>
          <ListChecks size={13} /> Jobs
        </Chip>
        <Chip active={look === 'chains'} onClick={() => setLook('chains')}>
          <Workflow size={13} /> Chains
        </Chip>
      </div>
      {look === 'chains' ? <ChainsTab scope={scope} /> : <JobList scope={scope} mode="process" />}
    </div>
  );
}
