"use client";

import { useState, useEffect } from "react";
import Link from "next/link";
import { AppLayout } from "@/components/AppLayout";
import { TrendingUp, Award, Wallet } from 'lucide-react';
import { useGlobalState } from "@/components/GlobalState";
import { PortfolioSummary, type PortfolioPosition } from "@/src/components/PortfolioSummary";
import { BulkClaimWizard, type BulkClaimPosition } from "@/src/components/BulkClaimWizard";
import { useWithdrawBase } from "@/src/hooks/useWithdrawBase";
import { useWithdrawStellar } from "@/src/hooks/useWithdrawStellar";
import { explorerTxUrl } from "@/src/lib/payout-utils";
import { AssetBridgeModal } from "@/src/components/AssetBridgeModal";

const API_BASE_URL = (
    process.env.NEXT_PUBLIC_API_BASE_URL ?? "http://127.0.0.1:3001"
).replace(/\/+$/, "");

interface Stake {
    id: string;
    title: string;
    choice: 'yes' | 'no';
    amount: number;
    chain: 'base' | 'stellar';
    timeLeft?: string;
    status: 'active' | 'settled' | 'claimable';
    payout?: number;
    result?: 'won' | 'lost';
}

function getTimeRemaining(endTs: string | number): string {
    try {
        const now = new Date();
        const end = new Date(endTs);
        const diff = Math.max(0, end.getTime() - now.getTime());
        
        if (diff === 0) return "Ended";
        
        const mins = Math.floor(diff / 60000);
        if (mins < 60) return `${mins}m`;
        
        const hrs = Math.floor(mins / 60);
        if (hrs < 24) return `${hrs}h`;
        
        const days = Math.floor(hrs / 24);
        return `${days}d`;
    } catch {
        return "TBD";
    }
}

export default function PortfolioPage() {
    const { currentUser } = useGlobalState();
    const [activeTab, setActiveTab] = useState<'active' | 'past' | 'claimable'>('active');
     const [stakes, setStakes] = useState<Stake[]>([]);
     const [isLoading, setIsLoading] = useState(true);
     const [claimWizardOpen, setClaimWizardOpen] = useState(false);
     const [bridgeOpen, setBridgeOpen] = useState(false);
     const baseWithdraw = useWithdrawBase();
     const stellarWithdraw = useWithdrawStellar();

    // Fetch user's stakes from backend
    useEffect(() => {
        const fetchStakes = async () => {
            setIsLoading(true);
            try {
                // Try to fetch from backend
                const encodedWallet = encodeURIComponent(currentUser?.wallet || 'demo');
                const response = await fetch(`${API_BASE_URL}/users/${encodedWallet}/stakes`);
                
                if (response.ok) {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    const data = await response.json() as any[];
                    // Process backend data and calculate PnL locally
                    const processedStakes: Stake[] = data.map((stake) => ({
                        id: (stake.id?.toString() || Math.random().toString()) as string,
                        title: (stake.callTitle || `Market ${stake.callId}`) as string,
                        choice: (stake.choice || 'yes') as 'yes' | 'no',
                        amount: parseFloat(stake.amount) || 0,
                        chain: (stake.chain || 'base') as 'base' | 'stellar',
                        timeLeft: (stake.timeLeft || 'TBD') as string,
                        status: (stake.status || 'active') as 'active' | 'settled' | 'claimable',
                        payout: stake.payout !== undefined ? parseFloat(stake.payout) : undefined,
                        result: stake.result as 'won' | 'lost' | undefined,
                    }));
                    setStakes(processedStakes);
                } else {
                    // Fallback to empty if endpoint not available
                    console.log('Stakes endpoint not available, using empty data');
                    setStakes([]);
                }
            } catch (error) {
                console.error('Failed to fetch stakes:', error);
                // Use empty data on error
                setStakes([]);
            } finally {
                setIsLoading(false);
            }
        };

        fetchStakes();
    }, [currentUser?.wallet]);

    // Fetch all calls for matching titles and calculating outcomes
    useEffect(() => {
        const enrichStakesWithCallData = async () => {
            try {
                const callsResponse = await fetch(`${API_BASE_URL}/calls`);
                if (!callsResponse.ok) return;

                const payload = await callsResponse.json() as {
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    data?: any[];
                };
                const calls = payload.data ?? [];

                // Map calls by ID for quick lookup
                const callsMap = new Map();
                calls.forEach((call) => {
                    callsMap.set(call.id, call);
                });

                // Enrich stakes with call data and calculate PnL
                setStakes((prevStakes) =>
                    prevStakes.map((stake): Stake => {
                        const call = callsMap.get(parseInt(stake.id));
                        
                        if (!call) return stake;

                        // Determine if stake is settled
                        const isSettled = call.status === 'SETTLED' || call.outcome !== null;
                        
                        if (isSettled && call.outcome !== null) {
                            // Calculate if stake won or lost
                            const stakeWon = (stake.choice === 'yes' && call.outcome === true) ||
                                           (stake.choice === 'no' && call.outcome === false);

                            // Calculate PnL based on pool odds (simplified)
                            const totalPool = (parseFloat(call.totalStakeYes) || 0) + 
                                            (parseFloat(call.totalStakeNo) || 0);
                            const userPool = stake.amount;
                            
                            let payout = 0;
                            if (stakeWon && totalPool > 0) {
                                // Proportional payout from losing side
                                const losingPool = stake.choice === 'yes' ? 
                                    (parseFloat(call.totalStakeNo) || 0) : 
                                    (parseFloat(call.totalStakeYes) || 0);
                                payout = stake.amount + (losingPool * (userPool / ((stake.choice === 'yes' ? parseFloat(call.totalStakeYes) : parseFloat(call.totalStakeNo)) || userPool)));
                            }

                            return {
                                ...stake,
                                title: call.conditionJson?.title || stake.title,
                                status: (stakeWon && payout > 0 ? 'claimable' : 'settled') as 'settled' | 'claimable',
                                payout: Math.max(0, payout),
                                result: (stakeWon ? 'won' : 'lost') as 'won' | 'lost',
                            };
                        }

                        // Active stake
                        if (!isSettled) {
                            return {
                                ...stake,
                                title: call.conditionJson?.title || stake.title,
                                status: 'active' as const,
                                timeLeft: getTimeRemaining(call.endTs),
                            };
                        }

                        return stake;
                    })
                );
            } catch (error) {
                console.error('Failed to enrich stakes with call data:', error);
            }
        };

        enrichStakesWithCallData();
    }, []);

    // Filter stakes by status
    const activeStakes = stakes.filter(s => s.status === 'active');
    const pastStakes = stakes.filter(s => s.status === 'settled');
    const claimableStakes = stakes.filter(s => s.status === 'claimable');

    // Calculate metrics locally
    const tvl = activeStakes.reduce((sum, s) => sum + s.amount, 0);
    const allTimePnL = stakes
        .filter(s => s.status !== 'active')
        .reduce((sum, s) => sum + ((s.payout || 0) - s.amount), 0);
    const totalSettled = pastStakes.length + claimableStakes.length;
    const wins = stakes.filter(s => s.result === 'won').length;
    const winRate = totalSettled > 0 ? (wins / totalSettled) * 100 : 0;

    const portfolioPositions: PortfolioPosition[] = stakes.map((stake) => ({
        id: stake.id,
        callId: stake.id,
        title: stake.title,
        chain: stake.chain,
        side: stake.choice,
        amount: stake.amount,
        payout: stake.payout,
        currentValue: stake.status === 'active' ? stake.amount : stake.payout,
        status: stake.status === 'claimable' ? 'claimable' : stake.status === 'active' ? 'active' : stake.result === 'won' ? 'won' : 'lost',
    }));

    const claimPositions: BulkClaimPosition[] = portfolioPositions.filter((position) => position.status === 'claimable').map((position) => ({ id: position.id, title: position.title, amount: position.payout || position.amount, chain: position.chain }));
    const claimPosition = async (position: BulkClaimPosition) => {
        const receipt = position.chain === 'base' ? await baseWithdraw.withdraw(position.amount) : await stellarWithdraw.withdraw(position.amount);
        return { txHash: receipt.txHash };
    };

    const currentStakes = activeTab === 'active' ? activeStakes : activeTab === 'past' ? pastStakes : claimableStakes;

    const RightSidebar = (
        <div className="space-y-6">
            <div className="bg-secondary/20 rounded-xl p-6 border border-border">
                <h3 className="font-bold text-lg mb-4">Portfolio Stats</h3>
                <div className="space-y-4">
                    <div>
                        <p className="text-xs text-muted-foreground mb-1">Total Value Locked</p>
                        <p className="text-2xl font-bold text-primary">${tvl}</p>
                    </div>
                    <div>
                        <p className="text-xs text-muted-foreground mb-1">All-Time Profit</p>
                        <p className={`text-2xl font-bold ${allTimePnL >= 0 ? 'text-green-500' : 'text-red-500'}`}>
                            {allTimePnL >= 0 ? '+' : ''}{allTimePnL.toFixed(0)}
                        </p>
                    </div>
                    <div>
                        <p className="text-xs text-muted-foreground mb-1">Win Rate</p>
                        <p className="text-2xl font-bold text-accent">{winRate.toFixed(1)}%</p>
                    </div>
                </div>
            </div>
        </div>
    );

    return (
        <AppLayout rightSidebar={RightSidebar}>
            <div className="p-4">
                <h1 className="text-2xl font-bold mb-1">Portfolio</h1>
                <div className="mb-6 flex items-center justify-between gap-3"><p className="text-muted-foreground text-sm">Track your positions, performance, and rewards</p><button type="button" onClick={() => setBridgeOpen(true)} className="rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary">Bridge assets</button></div>
                <PortfolioSummary positions={portfolioPositions} className="mb-6" onClaimAll={() => setClaimWizardOpen(true)} />

                {/* Tabs */}
                <div className="flex gap-1 mb-6 border-b border-border">
                    <button
                        onClick={() => setActiveTab('active')}
                        className={`flex items-center gap-2 px-4 py-3 font-medium text-sm border-b-2 transition-colors ${
                            activeTab === 'active'
                                ? 'border-primary text-primary'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        <Wallet className="h-4 w-4" />
                        Active Stakes ({activeStakes.length})
                    </button>
                    <button
                        onClick={() => setActiveTab('past')}
                        className={`flex items-center gap-2 px-4 py-3 font-medium text-sm border-b-2 transition-colors ${
                            activeTab === 'past'
                                ? 'border-primary text-primary'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        <TrendingUp className="h-4 w-4" />
                        Past Stakes ({pastStakes.length})
                    </button>
                    <button
                        onClick={() => setActiveTab('claimable')}
                        className={`flex items-center gap-2 px-4 py-3 font-medium text-sm border-b-2 transition-colors ${
                            activeTab === 'claimable'
                                ? 'border-primary text-primary'
                                : 'border-transparent text-muted-foreground hover:text-foreground'
                        }`}
                    >
                        <Award className="h-4 w-4" />
                        Claimable ({claimableStakes.length})
                    </button>
                </div>

                {/* Stakes List */}
                <div className="space-y-3">
                    {isLoading ? (
                        <div className="space-y-3">
                            {[1, 2, 3].map(i => (
                                <div key={i} className="h-24 bg-secondary/20 rounded-xl animate-pulse" />
                            ))}
                        </div>
                    ) : currentStakes.length > 0 ? (
                        currentStakes.map((stake) => (
                            <StakeItem key={stake.id} stake={stake} />
                        ))
                    ) : (
                        <div className="text-center py-12 flex flex-col items-center justify-center">
                            <p className="text-muted-foreground mb-4">
                                {activeTab === 'active' && 'No active stakes yet.'}
                                {activeTab === 'past' && 'No past stakes yet.'}
                                {activeTab === 'claimable' && 'No claimable payouts yet.'}
                            </p>
                            <Link href="/explore" className="bg-primary text-white px-6 py-2 rounded-xl font-bold hover:bg-primary/90 transition-colors">
                                Explore Markets
                            </Link>
                        </div>
                    )}
                </div>
            </div>
            <BulkClaimWizard open={claimWizardOpen} onOpenChange={setClaimWizardOpen} positions={claimPositions} onClaim={claimPosition} explorerUrl={(txHash, chain) => explorerTxUrl(chain, txHash)} />
            <AssetBridgeModal open={bridgeOpen} onOpenChange={setBridgeOpen} />
        </AppLayout>
    );
}

interface StakeItemProps {
    id: string;
    title: string;
    choice: 'yes' | 'no';
    amount: number;
    chain: 'base' | 'stellar';
    timeLeft?: string;
    status: 'active' | 'settled' | 'claimable';
    payout?: number;
    result?: 'won' | 'lost';
}

function StakeItem({ stake }: { stake: StakeItemProps }) {
    const isActive = stake.status === 'active';
    const isWon = stake.result === 'won';

    return (
        <div className="flex items-center justify-between p-4 rounded-xl bg-card border border-border hover:bg-secondary/30 transition-colors">
            <div className="flex-1">
                <h3 className="font-bold text-sm mb-2">{stake.title}</h3>
                <div className="flex items-center gap-3 text-sm">
                    <span className={`font-bold ${stake.choice === 'yes' ? 'text-green-500' : 'text-red-500'}`}>
                        {stake.choice === 'yes' ? '→ Yes' : '→ No'}
                    </span>
                    <span className={`text-xs px-2 py-0.5 rounded-full ${
                        stake.chain === 'base'
                            ? 'bg-blue-500/10 text-blue-500'
                            : 'bg-purple-500/10 text-purple-500'
                    }`}>
                        {stake.chain === 'base' ? 'Base' : 'Stellar'}
                    </span>
                    {isActive && (
                        <span className="text-muted-foreground text-xs">
                            Ends in {stake.timeLeft}
                        </span>
                    )}
                </div>
            </div>

            <div className="text-right space-y-1">
                <p className="font-bold text-sm">${stake.amount}</p>
                {!isActive && (
                    <>
                        <p className={`text-xs font-bold ${stake.payout ? 'text-green-500' : 'text-red-500'}`}>
                            {isWon ? '✓ Won' : '✗ Lost'}
                        </p>
                        {stake.payout && stake.payout > 0 && (
                            <p className="text-xs text-muted-foreground">
                                Payout: ${stake.payout}
                            </p>
                        )}
                    </>
                )}
                {stake.status === 'claimable' && (
                    <button className="mt-2 w-full px-2 py-1 rounded-lg bg-primary text-white text-xs font-bold hover:bg-primary/90 transition-colors">
                        Claim
                    </button>
                )}
            </div>
        </div>
    );
}
