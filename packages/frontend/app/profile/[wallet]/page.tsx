'use client';

/**
 * Public profile: reputation, follower stats, call history and export (FE-07).
 *
 * `/profile` remains the signed-in user's own page; this route is the
 * addressable one you can link to and share.
 */

import * as React from 'react';
import { useParams } from 'next/navigation';
import { AppLayout } from '@/components/AppLayout';
import { useGlobalState } from '@/components/GlobalState';
import { useChain } from '@/components/ChainProvider';
import dynamic from 'next/dynamic';
import { ProfileHeader } from '@/src/components/ProfileHeader';
import { dynamicSkeleton } from '@/src/lib/perf';
import { ExportButton } from '@/src/components/ExportButton';
import { FollowButton } from '@/src/components/follow';
import { useProfile } from '@/src/hooks/useProfile';
import { useFollow } from '@/src/hooks/useFollow';
import { AvatarUploader } from '@/src/components/AvatarUploader';
import { BadgeGallery } from '@/src/components/BadgeGallery';
import { SocialGraphNetwork } from '@/src/components/SocialGraphNetwork';

/**
 * The reputation timeline pulls in `lightweight-charts`, which is only needed
 * once this page has history to draw. Loading it on demand keeps the charting
 * runtime out of the route's initial JavaScript payload. The skeleton reserves
 * the chart's height so swapping it in causes no layout shift.
 */
const ReputationTimeline = dynamic(
  () => import('@/src/components/ReputationTimeline').then((m) => m.ReputationTimeline),
  {
    ssr: false,
    loading: () =>
      dynamicSkeleton({ loaderLabel: 'Loading reputation timeline...', minHeight: 320 }),
  },
);

export default function WalletProfilePage() {
  const params = useParams<{ wallet: string | string[] }>();
  const rawWallet = params?.wallet;
  const wallet = Array.isArray(rawWallet) ? rawWallet[0] : rawWallet;

  const { currentUser } = useGlobalState();
  const { selectedChain } = useChain();

  const { user, history, isLoading, isHistoryLoading, error, exportHistory } = useProfile(wallet);
  const { stats } = useFollow(wallet ?? '', currentUser?.wallet);

  const isSelf = Boolean(
    wallet && currentUser?.wallet && wallet.toLowerCase() === currentUser.wallet.toLowerCase(),
  );

  const graph = React.useMemo(() => {
    const people = history.slice(0, 8).map((entry) => ({
      id: entry.id,
      label: entry.token,
      volume: entry.stake,
      category: entry.category || 'Market',
      reputation: entry.reputationDelta > 0 ? 80 : 55,
      summary: `${entry.outcome === 'open' ? 'Active' : entry.outcome} · ${entry.stake} staked`,
    }));
    const root = { id: wallet ?? '', label: user?.displayName || 'Profile', volume: people.reduce((total, person) => total + person.volume, 0), category: 'Profile', reputation: user?.reputationScore ?? 0, summary: user?.bio || 'Profile activity' };
    return {
      nodes: [root, ...people],
      edges: people.map((person) => ({ source: wallet ?? '', target: person.id, agreement: person.reputation >= 60 ? 'co-back' as const : 'counter-back' as const, weight: person.volume })),
    };
  }, [history, user, wallet]);

  if (!wallet) {
    return (
      <AppLayout rightSidebar={null}>
        <div className="p-8 text-center text-muted-foreground">No wallet in this URL.</div>
      </AppLayout>
    );
  }

  return (
    <AppLayout rightSidebar={null}>
      <div className="w-full">
        {isLoading ? (
          <div data-testid="profile-loading" className="p-8 text-center text-muted-foreground">
            Loading profile…
          </div>
        ) : null}

        {error ? (
          <div role="alert" data-testid="profile-error" className="p-8 text-center text-red-600">
            {error.message}
          </div>
        ) : null}

        {user ? (
          <>
            <ProfileHeader
              user={{ ...user, wallet: user.wallet ?? wallet }}
              socialStats={{
                followersCount: stats?.followersCount ?? 0,
                followingCount: stats?.followingCount ?? 0,
              }}
              currentChain={selectedChain === 'stellar' ? 'stellar' : 'base'}
              reputationScore={user.reputationScore ?? null}
              showEditButton={isSelf}
              actions={
                <>
                  <FollowButton profileAddress={wallet} viewerAddress={currentUser?.wallet} />
                  <ExportButton wallet={wallet} entries={history} fetchExport={exportHistory} />
                </>
              }
            />

            {isSelf ? (
              <div className="px-4 pb-2">
                <AvatarUploader size={96} />
              </div>
            ) : null}

            <div className="px-4 pb-8">
              {isHistoryLoading ? (
                <p data-testid="history-loading" className="py-6 text-center text-muted-foreground">
                  Loading call history…
                </p>
              ) : (
                <ReputationTimeline
                  entries={history}
                  currentScore={user.reputationScore ?? 0}
                />
              )}
              <div className="mt-4">
                <BadgeGallery progress={{
                  'first-call': history.length,
                  'sharp-shooter': history.filter((entry) => entry.outcome === 'won').length,
                  'streak-master': history.filter((entry) => entry.outcome === 'won').length,
                  'oracle': user.reputationScore ?? 0,
                  'community-pillar': stats?.followersCount ?? 0,
                }} />
                <SocialGraphNetwork nodes={graph.nodes} edges={graph.edges} />
              </div>
            </div>
          </>
        ) : null}
      </div>
    </AppLayout>
  );
}
