import { Nav } from "@/components/nav";
import { OfflineBanner } from "@/src/components/OfflineBanner";
import { Header } from "@/src/components/Header";
import { RpcHealthIndicator } from "@/src/components/RpcHealthIndicator";
import { StakingSlipDrawer } from "@/src/components/StakingSlipDrawer";
import { StakingSlipProvider } from "@/src/context/StakingSlipContext";
import { WidgetErrorBoundary } from "@/src/components/WidgetErrorBoundary";

export function AppLayout({
    children,
    rightSidebar
}: {
    children: React.ReactNode,
    rightSidebar?: React.ReactNode
}) {
    const rpcEndpoints = [
        process.env.NEXT_PUBLIC_SOROBAN_RPC,
        process.env.NEXT_PUBLIC_SOROBAN_RPC_FALLBACK,
    ].filter((url): url is string => Boolean(url)).map((url, index) => ({ id: index === 0 ? 'primary' : 'fallback', url, network: 'TESTNET' }));

    return (
        <StakingSlipProvider>
            <div className="min-h-screen bg-background">
                <Header />
                <OfflineBanner />
                {rpcEndpoints.length > 0 ? <div className="flex justify-end px-4 py-1"><RpcHealthIndicator endpoints={rpcEndpoints} /></div> : null}
                <div className="max-w-7xl mx-auto flex justify-center min-h-screen">
                    {/*
                      Each region gets its own boundary so a crash in one does not
                      take the others down with it: navigation staying up is what
                      lets someone leave a broken page without a full reload.
                    */}
                    <WidgetErrorBoundary widget="Navigation">
                        <Nav />
                    </WidgetErrorBoundary>

                    <main id="main-content" className="flex-1 max-w-2xl w-full border-x border-border min-h-screen">
                        <WidgetErrorBoundary widget="Page content">
                            {children}
                        </WidgetErrorBoundary>
                    </main>

                    {rightSidebar && (
                        <aside className="hidden lg:block sticky top-0 h-screen w-80 p-6 overflow-y-auto">
                            <WidgetErrorBoundary widget="Sidebar">
                                {rightSidebar}
                            </WidgetErrorBoundary>
                        </aside>
                    )}
                </div>
                <StakingSlipDrawer />
            </div>
        </StakingSlipProvider>
    );
}
