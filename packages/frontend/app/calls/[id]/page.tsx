"use client";

import { useParams } from "next/navigation";
import { AppLayout } from "@/components/AppLayout";
import { ArrowLeft, TrendingUp, Clock, ShieldCheck, Users, MessageSquare, Share2, Flag, Target, Wallet, BarChart3 } from 'lucide-react';
import Link from "next/link";
import { cn } from "@/lib/utils";
import { useGlobalState } from "@/components/GlobalState";
import * as React from "react";
import { useState, useEffect } from "react";
import { Loader } from "@/components/ui/Loader";
import dynamic from "next/dynamic";
import { dynamicSkeleton } from "@/src/lib/perf";
import { WidgetErrorBoundary } from "@/src/components/WidgetErrorBoundary";
const PriceChart = dynamic(() => import("@/components/PriceChart").then((m) => m.PriceChart), {
  ssr: false,
  loading: () => dynamicSkeleton({ loaderLabel: "Loading price chart...", minHeight: 300 }),
});
import { ActivityLog } from "@/components/ActivityLog";
import { MarketDetailSkeleton } from "@/components/MarketDetailSkeleton";
import { MarketDetailRightSidebarSkeleton } from "@/components/MarketDetailRightSidebarSkeleton";
import { PoolBar } from "@/src/components/PoolBar";
import { ParticipantList } from "@/src/components/ParticipantList";
import { PoolLiquidityDepth } from "@/src/components/PoolLiquidityDepth";
import { SocialCardGenerator } from "@/src/components/SocialCardGenerator";
import { CallCountdownTimeline } from "@/src/components/CallCountdownTimeline";
import { DisputeThread } from "@/src/components/DisputeThread";
import { createMockCallSocket, useCallLive, poolSplit } from "@/src/hooks/useCallLive";
import { LiveRegion } from "@/src/components/LiveRegion";
import * as Dialog from "@radix-ui/react-dialog";
import { toast } from "sonner";

// ── NEW: USDC uses 6 decimal places on Base ──────────────────────────────────
const USDC_DECIMALS = 6;

// Returns an error string if the input is invalid, null if it's fine
function validateAmount(raw: string, walletBalance: number | null): string | null {
    if (!raw || raw.trim() === "") return "Please enter an amount.";
    const value = parseFloat(raw);
    if (isNaN(value) || value <= 0) return "Amount must be greater than 0.";
    const parts = raw.split(".");
    if (parts[1] && parts[1].length > USDC_DECIMALS) {
        return `Max ${USDC_DECIMALS} decimal places for USDC.`;
    }
    if (walletBalance !== null && value > walletBalance) {
        return "Amount exceeds your wallet balance.";
    }
    return null;
}
// ─────────────────────────────────────────────────────────────────────────────

export default function CallDetailPage() {
    const params = useParams();
    const id = params?.id as string;
    const { calls, stakeOnCall, isLoading, stakingStep, currentUser } = useGlobalState();
    const [stakingType, setStakingType] = useState<'back' | 'challenge' | null>(null);
    const [isFetching, setIsFetching] = useState(true);
    const [isShareDialogOpen, setIsShareDialogOpen] = useState(false);

    // ── NEW: stake amount state ───────────────────────────────────────────────
    const [stakeAmount, setStakeAmount] = useState<string>("");
    const [amountError, setAmountError] = useState<string | null>(null);
    // Pull the balance from currentUser if GlobalState exposes it.
    // If you use wagmi's useBalance instead, swap this line for that hook's value.
    const walletBalance: number | null = currentUser?.usdcBalance ?? null;
    // ─────────────────────────────────────────────────────────────────────────

    const call = calls.find(c => c.id === id);

    // FE-05: live pool and participants for this call. The socket factory is
    // the seam — swapping the mock for the real Socket.io client is a one-line
    // change here once the `market:<id>` room exists server-side.
    const socketFactory = React.useMemo(
        () =>
            createMockCallSocket({
                seed: {
                    yesTotal: Number(call?.totalStakeYes ?? 0) || 0,
                    noTotal: Number(call?.totalStakeNo ?? 0) || 0,
                },
            }),
        [call?.totalStakeYes, call?.totalStakeNo],
    );

    const live = useCallLive(id ?? '', { socketFactory });

    // Quantised to whole percents: announcing every fractional socket tick
    // would make the region chatter and drown out anything else being read.
    const { yesPercent } = poolSplit(live.pool);
    const poolAnnouncement = live.connected
        ? `Live pool updated: ${Math.round(yesPercent)} percent backing`
        : '';

    const stepLabels: Record<string, string> = {
        idle: "",
        approving: "Step 1/2: Approving token…",
        approved: "Step 1/2: Approval confirmed",
        staking: "Step 2/2: Staking…",
        confirmed: "Step 2/2: Confirmed",
    };

    const stepProgress: Record<string, number> = {
        idle: 0,
        approving: 25,
        approved: 50,
        staking: 75,
        confirmed: 100,
    };

    useEffect(() => {
        if (calls.length > 0) {
            const timer = setTimeout(() => setIsFetching(false), 300);
            return () => clearTimeout(timer);
        }
    }, [calls]);

    if (isFetching) {
        return (
            <AppLayout rightSidebar={<MarketDetailRightSidebarSkeleton />}>
                <MarketDetailSkeleton />
            </AppLayout>
        );
    }

    if (!call) {
        return (
            <AppLayout>
                <div className="min-h-[50vh] flex flex-col items-center justify-center text-muted-foreground">
                    <h2 className="text-xl font-bold mb-2">Call not found</h2>
                    <Link href="/feed" className="text-primary hover:underline">Return to Feed</Link>
                </div>
            </AppLayout>
        );
    }

    const startPrice = 0.12;
    const targetPrice = parseFloat(String(call.target || "").replace(/[^0-9.]/g, "")) || startPrice * 1.25;
    const shareTitle = String(call.title || call.conditionJson?.title || "Check out this market");

    const handleCopyLink = async () => {
        try {
            await navigator.clipboard.writeText(window.location.href);
            toast.success("Link copied to clipboard.");
            setIsShareDialogOpen(false);
        } catch (error) {
            console.error("Failed to copy share link:", error);
            toast.error("Couldn’t copy the link right now.");
        }
    };

    const handleShareToX = () => {
        const intentUrl = new URL("https://twitter.com/intent/tweet");
        intentUrl.searchParams.set("text", `Check out this prediction: ${shareTitle}`);
        intentUrl.searchParams.set("url", window.location.href);
        window.open(intentUrl.toString(), "_blank", "noopener,noreferrer");
        setIsShareDialogOpen(false);
    };

    // ── NEW: handlers ─────────────────────────────────────────────────────────
    function handleAmountChange(val: string) {
        setStakeAmount(val);
        setAmountError(validateAmount(val, walletBalance));
    }

    function handleMax() {
        if (walletBalance !== null) {
            const maxStr = walletBalance.toFixed(USDC_DECIMALS);
            setStakeAmount(maxStr);
            setAmountError(validateAmount(maxStr, walletBalance));
        }
    }

    async function handleConfirmStake() {
        const error = validateAmount(stakeAmount, walletBalance);
        if (error) { setAmountError(error); return; }
        // BEFORE: await stakeOnCall(id, 100, stakingType);
        // AFTER:
        await stakeOnCall(id, parseFloat(stakeAmount), stakingType!);
        setStakingType(null);
        setStakeAmount("");
        setAmountError(null);
    }
    // ─────────────────────────────────────────────────────────────────────────

    const RightSidebar = (
        <div className="space-y-6">
            <div className="bg-secondary/20 rounded-xl p-6 border border-border">
                <h3 className="font-bold text-lg mb-4 flex items-center gap-2">
                    <BarChart3 className="h-5 w-5 text-primary" />
                    Market Stats
                </h3>
                <div className="space-y-4">
                    <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">Total Volume</span>
                        <span className="font-bold text-foreground">{String(call.volume || "$0")}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">Participants</span>
                        <span className="font-bold text-foreground">{String(call.backers || 0)}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">Total Staked</span>
                        <span className="font-bold text-green-500">{String(call.totalStakeYes || 0)} USDC</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">Challenged</span>
                        <span className="font-bold text-red-500">{String(call.totalStakeNo || 0)} USDC</span>
                    </div>
                    <div className="h-px bg-border my-2" />
                    <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">Start Price</span>
                        <span className="font-medium text-foreground">${startPrice.toFixed(6)}</span>
                    </div>
                    <div className="flex justify-between items-center text-sm">
                        <span className="text-muted-foreground">Target Price</span>
                        <span className="font-medium text-accent">${targetPrice.toFixed(6)}</span>
                    </div>

                    {/* FE-05: live pool split and participants, pushed over
                        the `market:<id>` room. */}
                    <div className="h-px bg-border my-2" />
                    <div className="flex flex-col gap-3">
                        <div className="flex items-center justify-between text-sm">
                            <span className="text-muted-foreground">Live pool</span>
                            {live.connected ? (
                                <span data-testid="live-indicator" className="text-xs text-green-500">
                                    Live
                                </span>
                            ) : null}
                        </div>

                        <PoolBar pool={live.pool} />
                        <PoolLiquidityDepth pool={live.pool} />

                        {/*
                          The bar above moves silently as socket updates land.
                          This announces the new split so screen reader users
                          learn the pool changed without polling the page.
                        */}
                        <LiveRegion message={poolAnnouncement} />

                        <div className="flex flex-col gap-2">
                            <span className="text-sm text-muted-foreground">Participants</span>
                            <ParticipantList participants={live.participants} />
                        </div>
                    </div>
                </div>
            </div>

            <div className="bg-secondary/20 rounded-xl p-6 border border-border">
                <h3 className="font-bold text-lg mb-4">About Creator</h3>
                <div className="flex items-center gap-3 mb-4">
                    <div className={`h-12 w-12 rounded-full ${call.creator?.avatar || 'bg-primary'} flex items-center justify-center font-bold text-white`}>
                        {(call.creator?.displayName || call.creator?.wallet?.slice(0, 6) || "U").substring(0, 2).toUpperCase()}
                    </div>
                    <div>
                        <div className="font-bold">{call.creator?.displayName || call.creator?.wallet?.slice(0, 6) || "Anonymous"}</div>
                        <div className="text-xs text-muted-foreground">{call.creator?.handle || '@anonymous'}</div>
                    </div>
                </div>
                <p className="text-sm text-muted-foreground">
                    This creator has made {String(call.backers || 0)} successful predictions with a total volume of {String(call.volume || "$0")}.
                </p>
            </div>
        </div>
    );

    return (
        <AppLayout rightSidebar={RightSidebar}>
            {isLoading && stakingStep !== "idle" && (
                <Loader text={stepLabels[stakingStep as keyof typeof stepLabels] || "Processing transaction..."} />
            )}

            <header className="sticky top-0 z-40 bg-background/80 backdrop-blur-md border-b border-border px-4 py-3 flex items-center gap-4">
                <Link href="/feed" className="p-2 hover:bg-secondary rounded-full transition-colors">
                    <ArrowLeft className="h-5 w-5" />
                </Link>
                <div className="flex-1">
                    <h1 className="text-lg font-bold truncate">{String(call.asset || "Unknown")}/{String(call.target || "TBD")}</h1>
                    <p className="text-xs text-muted-foreground">Market Detail</p>
                </div>
                <div className="flex items-center gap-2">
                    <Dialog.Root open={isShareDialogOpen} onOpenChange={setIsShareDialogOpen}>
                        <Dialog.Trigger asChild>
                            <button
                                className="p-2 hover:bg-secondary rounded-full transition-colors text-muted-foreground hover:text-foreground"
                                aria-label="Share this market"
                            >
                                <Share2 className="h-5 w-5" />
                            </button>
                        </Dialog.Trigger>
                        <Dialog.Portal>
                            <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
                            <Dialog.Content
                                className="fixed left-1/2 top-1/2 z-50 w-[calc(100%-2rem)] max-w-md -translate-x-1/2 -translate-y-1/2 rounded-2xl border border-border bg-card p-6 shadow-2xl outline-none"
                                aria-describedby="share-market-description"
                            >
                                <Dialog.Title className="text-xl font-bold text-foreground">
                                    Share this market
                                </Dialog.Title>
                                <Dialog.Description
                                    id="share-market-description"
                                    className="mt-2 text-sm text-muted-foreground"
                                >
                                    Spread the word with a quick link or a pre-filled post on X.
                                </Dialog.Description>

                                <div className="mt-6 space-y-3">
                                    <button
                                        type="button"
                                        onClick={handleCopyLink}
                                        className="flex w-full items-center justify-center rounded-xl border border-border px-4 py-3 text-sm font-medium transition-colors hover:bg-secondary"
                                    >
                                        Copy Link
                                    </button>
                                    <button
                                        type="button"
                                        onClick={handleShareToX}
                                        className="flex w-full items-center justify-center rounded-xl bg-primary px-4 py-3 text-sm font-semibold text-primary-foreground transition-colors hover:opacity-90"
                                    >
                                        Share to X
                                    </button>
                                </div>
                                <SocialCardGenerator
                                    className="mt-4"
                                    data={{
                                        title: shareTitle,
                                        creator: call.creator?.displayName || call.creator?.wallet,
                                        token: call.asset,
                                        target: call.target,
                                        yesPercent: live.yesPercent,
                                        noPercent: live.noPercent,
                                        url: typeof window !== 'undefined' ? window.location.href : undefined,
                                    }}
                                />
                            </Dialog.Content>
                        </Dialog.Portal>
                    </Dialog.Root>
                    <button className="p-2 hover:bg-secondary rounded-full transition-colors text-muted-foreground hover:text-foreground">
                        <Flag className="h-5 w-5" />
                    </button>
                </div>
            </header>

            <div className="p-6">
                <section className="mb-8">
                    {/*
                      Charting runs against live market data and a canvas
                      renderer, so it is the most likely thing on this page to
                      throw. Isolating it keeps the stake and activity controls
                      below usable when it does.
                    */}
                    <WidgetErrorBoundary widget="Chart">
                        <PriceChart
                            asset={call.asset || "Unknown"}
                            target={call.target || "TBD"}
                            startPrice={startPrice}
                            targetPrice={targetPrice}
                        />
                    </WidgetErrorBoundary>
                </section>

                <div className="mb-6">
                    <div className="flex items-center gap-2 mb-4">
                        <div className={`h-10 w-10 rounded-full ${call.creator?.avatar || 'bg-primary'} flex items-center justify-center font-bold text-white text-sm`}>
                            {(call.creator?.displayName || call.creator?.wallet?.slice(0, 6) || "U").substring(0, 2).toUpperCase()}
                        </div>
                        <div>
                            <div className="font-bold">{call.creator?.displayName || call.creator?.wallet?.slice(0, 6) || "Anonymous"}</div>
                            <div className="text-xs text-muted-foreground">{call.creator?.handle || '@anonymous'} • {call.createdAt || "Unknown date"}</div>
                        </div>
                    </div>

                    <h1 className="text-2xl font-bold mb-4 leading-tight">{call.title || "Untitled Call"}</h1>

                    <div className="flex flex-wrap gap-3 mb-6">
                        <Badge icon={<TrendingUp className="h-4 w-4" />} label={`${String(call.asset || "Unknown")} ➜ ${String(call.target || "TBD")}`} color="primary" />
                        <Badge icon={<ShieldCheck className="h-4 w-4" />} label={`Stake: ${String(call.stake || "0 USDC")}`} color="accent" />
                        <Badge icon={<Clock className="h-4 w-4" />} label={`By ${call.deadline || "TBD"}`} color="secondary" />
                    </div>
                </div>

                <section className="mb-8">
                    <div className="bg-gradient-to-br from-secondary/50 to-secondary/20 rounded-xl p-6 border border-border">
                        <div className="flex items-center gap-2 mb-4">
                            <Target className="h-5 w-5 text-primary" />
                            <h3 className="font-bold text-sm uppercase tracking-wider text-muted-foreground">Creator&apos;s Thesis</h3>
                        </div>
                        <p className="text-lg leading-relaxed text-foreground">{call.thesis || "No thesis provided."}</p>
                        <div className="mt-4 pt-4 border-t border-border/50 flex items-center gap-4 text-sm text-muted-foreground">
                            <span className="flex items-center gap-1">
                                <Wallet className="h-4 w-4" />
                                Stake: {String(call.stake || "0 USDC")}
                            </span>
                            <span className="flex items-center gap-1">
                                <Clock className="h-4 w-4" />
                                Deadline: {call.deadline || "TBD"}
                            </span>
                        </div>
                    </div>
                </section>

                <section className="mb-8">
                    <CallCountdownTimeline status={call.status} deadline={call.deadline || call.endTs} onExpired={() => setIsFetching(false)} />
                </section>

                {/* Action Buttons */}
                <section className="mb-8">
                    {stakingType ? (
                        <div className="bg-card border border-border rounded-xl p-6 animate-in fade-in zoom-in-95">
                            <h3 className="font-bold text-lg mb-4">
                                Confirm {stakingType === 'back' ? 'Backing' : 'Challenge'}
                            </h3>

                            {/* ── NEW: amount input (replaces the hardcoded "100 USDC" text) ── */}
                            <div className="mb-4 space-y-1">
                                <label htmlFor="stake-amount" className="block text-sm font-medium text-muted-foreground">
                                    Amount (USDC)
                                </label>
                                <div className="flex items-center gap-2">
                                    <input
                                        id="stake-amount"
                                        type="number"
                                        min="0"
                                        step="0.000001"
                                        placeholder="0.00"
                                        value={stakeAmount}
                                        onChange={(e) => handleAmountChange(e.target.value)}
                                        className={cn(
                                            "w-full rounded-lg border px-3 py-2 text-sm bg-background",
                                            "focus:outline-none focus:ring-2 focus:ring-primary",
                                            amountError ? "border-red-500" : "border-border"
                                        )}
                                    />
                                    <button
                                        type="button"
                                        onClick={handleMax}
                                        disabled={walletBalance === null}
                                        className="shrink-0 rounded-lg border border-border px-3 py-2 text-sm
                                            font-medium hover:bg-secondary transition-colors disabled:opacity-40"
                                    >
                                        Max
                                    </button>
                                </div>
                                {walletBalance !== null && (
                                    <p className="text-xs text-muted-foreground">
                                        Balance: {walletBalance.toFixed(2)} USDC
                                    </p>
                                )}
                                {amountError && (
                                    <p className="text-xs text-red-500">{amountError}</p>
                                )}
                            </div>
                            {/* ──────────────────────────────────────────────────────────── */}

                            {stakingStep !== "idle" && (
                                <div className="mb-4">
                                    <p className="text-sm font-medium mb-2">{stepLabels[stakingStep]}</p>
                                    <div className="w-full bg-secondary rounded-full h-2 overflow-hidden">
                                        <div
                                            className="h-full bg-primary transition-all duration-500"
                                            style={{ width: `${stepProgress[stakingStep as keyof typeof stepProgress]}%` }}
                                        />
                                    </div>
                                </div>
                            )}

                            <div className="flex gap-3">
                                <button
                                    onClick={() => { setStakingType(null); setStakeAmount(""); setAmountError(null); }}
                                    disabled={isLoading}
                                    className="flex-1 py-3 rounded-xl font-medium hover:bg-secondary transition-colors disabled:opacity-50"
                                >
                                    Cancel
                                </button>
                                <button
                                    onClick={handleConfirmStake}
                                    disabled={isLoading || !!amountError || !stakeAmount}
                                    className={cn(
                                        "flex-1 py-3 rounded-xl font-bold text-white transition-colors disabled:opacity-50",
                                        stakingType === 'back'
                                            ? 'bg-green-500 hover:bg-green-600'
                                            : 'bg-red-500 hover:bg-red-600'
                                    )}
                                >
                                    {isLoading ? "Processing..." : "Confirm Stake"}
                                </button>
                            </div>
                        </div>
                    ) : (
                        <div className="grid grid-cols-2 gap-4">
                            <button
                                onClick={() => setStakingType('back')}
                                className="py-4 rounded-xl bg-green-500/10 text-green-500 font-bold hover:bg-green-500/20 transition-colors flex flex-col items-center gap-1 border border-green-500/20"
                            >
                                <span>Back this Call</span>
                                <span className="text-xs font-normal opacity-80">Agree with prediction</span>
                            </button>
                            <button
                                onClick={() => setStakingType('challenge')}
                                className="py-4 rounded-xl bg-red-500/10 text-red-500 font-bold hover:bg-red-500/20 transition-colors flex flex-col items-center gap-1 border border-red-500/20"
                            >
                                <span>Challenge</span>
                                <span className="text-xs font-normal opacity-80">Bet against it</span>
                            </button>
                        </div>
                    )}
                </section>

                <section className="mb-8">
                    <div className="flex items-center gap-2 mb-4">
                        <Users className="h-5 w-5 text-primary" />
                        <h3 className="text-xl font-bold">Recent Activity</h3>
                    </div>
                    <ActivityLog />
                </section>

                <section className="mb-8">
                    <DisputeThread callId={id} />
                </section>

                <div className="flex items-center justify-between border-y border-border py-4">
                    <div className="flex gap-6">
                        <div className="flex items-center gap-2 text-muted-foreground">
                            <Users className="h-5 w-5" />
                            <span className="font-medium">{String(call.backers || 0)} Backers</span>
                        </div>
                        <div className="flex items-center gap-2 text-muted-foreground">
                            <MessageSquare className="h-5 w-5" />
                            <span className="font-medium">{String(call.comments || 0)} Comments</span>
                        </div>
                    </div>
                </div>
            </div>
        </AppLayout>
    );
}

function Badge({ icon, label, color }: { icon: React.ReactNode, label: string, color: 'primary' | 'secondary' | 'accent' }) {
    const colors = {
        primary: "bg-primary/10 text-primary border-primary/20",
        secondary: "bg-secondary text-muted-foreground border-border",
        accent: "bg-accent/10 text-accent border-accent/20",
    };

    return (
        <div className={cn("inline-flex items-center gap-2 px-3 py-1.5 rounded-lg font-medium text-sm border", colors[color])}>
            {icon}
            {label}
        </div>
    );
}
