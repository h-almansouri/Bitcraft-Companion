import { num } from '../../lib/format.ts';
import { Card, SectionLabel, TierChip } from '../../ui/kit.tsx';
import type { PushScope } from '../PushPage.tsx';

/**
 * What a finished push shows in place of Gather and Process: simply what it made.
 * The materials have been spent by then, so nothing here is checked against storage.
 */
export function CompletedTab({ scope }: { scope: PushScope }) {
  const { ctx, push } = scope;
  const goals = push.goals.map((goal) => ({ goal, thing: ctx.book.thing(goal.id) }));
  const groups = [
    { title: 'Built', list: goals.filter((g) => g.goal.id.startsWith('b.')) },
    { title: 'Made', list: goals.filter((g) => !g.goal.id.startsWith('b.')) },
  ].filter((group) => group.list.length);

  if (!goals.length) return <p className="text-sm text-ink-2">This push had no goals.</p>;
  return (
    <div className="space-y-6">
      {groups.map((group) => (
        <section key={group.title}>
          <SectionLabel>
            {group.title} <span className="num">{group.list.length}</span>
          </SectionLabel>
          <Card className="mt-2 grid grid-cols-1 gap-x-8 px-4 py-1.5 sm:grid-cols-2">
            {group.list.map(({ goal, thing }) => (
              <div key={goal.id} className="flex items-center gap-2.5 py-1.5 text-sm">
                {/* Things with no tier keep the same indent, so the names line up. */}
                <span className="flex w-[22px] shrink-0">
                  <TierChip tier={thing?.tier ?? 0} />
                </span>
                <span className="min-w-0 flex-1 truncate">{thing?.name ?? ctx.book.name(goal.id)}</span>
                <span className="num text-ink-2">{num(goal.qty)}</span>
              </div>
            ))}
          </Card>
        </section>
      ))}
    </div>
  );
}
