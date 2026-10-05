"use client";

import { useState } from "react";
import { useRouter } from "next/navigation";
import { CheckCircle2, ArrowRight, Shield, Wallet, KeyRound } from "lucide-react";
import { Logo } from "@/components/logo";
import { OnboardPasskey } from "@/src/components/OnboardPasskey";
import { SmartAccountPreview } from "@/src/components/SmartAccountPreview";
import { Button } from "@/components/ui/Button";
import { Card, CardContent } from "@/components/ui/Card";

type OnboardStep = "passkey" | "wallet" | "smart-account" | "complete";

export default function OnboardPage() {
  const [step, setStep] = useState<OnboardStep>("passkey");
  const [, setPasskeyCreated] = useState(false);
  const [walletAddress, setWalletAddress] = useState<string | null>(null);
  const router = useRouter();

  const steps: Array<{ key: OnboardStep; label: string; icon: React.ReactNode }> = [
    { key: "passkey", label: "Passkey", icon: <KeyRound className="h-4 w-4" /> },
    { key: "wallet", label: "Wallet", icon: <Wallet className="h-4 w-4" /> },
    { key: "smart-account", label: "Smart Account", icon: <Shield className="h-4 w-4" /> },
  ];

  return (
    <div className="min-h-screen flex flex-col items-center justify-center p-4 relative overflow-hidden">
      <div className="absolute top-0 left-0 w-full h-full overflow-hidden -z-10">
        <div className="absolute top-1/4 left-1/4 w-96 h-96 bg-primary/10 rounded-full blur-3xl" />
        <div className="absolute bottom-1/4 right-1/4 w-96 h-96 bg-accent/10 rounded-full blur-3xl" />
      </div>

      <div className="w-full max-w-md">
        <div className="text-center mb-8">
          <Logo size="xl" className="justify-center mb-4" />
          <div className="flex items-center justify-center gap-2 mb-4">
            {steps.map((s, i) => (
              <div key={s.key} className="flex items-center gap-2">
                {i > 0 && <div className={`h-1 w-8 rounded-full ${steps.findIndex(x => x.key === step) >= i ? "bg-primary" : "bg-secondary"}`} />}
                <div className={`h-8 w-8 rounded-full flex items-center justify-center text-sm font-bold transition-all ${
                    steps.findIndex(x => x.key === step) >= i
                      ? "bg-primary text-primary-foreground"
                      : "bg-secondary text-muted-foreground"
                  }`}>
                  {s.icon}
                </div>
              </div>
            ))}
          </div>
        </div>

        <Card className="shadow-xl backdrop-blur-sm">
          <CardContent className="p-6 md:p-8">
            {step === "passkey" && (
              <OnboardPasskey
                onComplete={(addr) => {
                  setPasskeyCreated(true);
                  setWalletAddress(addr);
                  setStep("wallet");
                }}
                onFallback={() => setStep("wallet")}
              />
            )}

            {step === "wallet" && (
              <div className="space-y-6 animate-in fade-in slide-in-from-right-4">
                <div className="text-center">
                  <h2 className="text-2xl font-bold mb-2">Embedded Wallet</h2>
                  <p className="text-muted-foreground">Your passkey-secured wallet is ready.</p>
                </div>
                {walletAddress && (
                  <div className="bg-secondary/50 rounded-lg p-4 border border-border">
                    <p className="text-xs text-muted-foreground mb-1">Wallet Address</p>
                    <p className="font-mono text-sm break-all">{walletAddress}</p>
                  </div>
                )}
                <div className="bg-primary/10 border border-primary/20 rounded-lg p-4">
                  <p className="text-sm text-primary">
                    Sponsorship notice: Gas fees for your first transactions will be sponsored by BackIT.
                  </p>
                </div>
                <Button onClick={() => setStep("smart-account")} className="w-full">
                  Continue
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            )}

            {step === "smart-account" && (
              <SmartAccountPreview
                walletAddress={walletAddress}
                onComplete={() => setStep("complete")}
              />
            )}

            {step === "complete" && (
              <div className="text-center space-y-6 animate-in fade-in slide-in-from-right-4">
                <div className="h-20 w-20 bg-green-500/20 text-green-500 rounded-full flex items-center justify-center mx-auto">
                  <CheckCircle2 className="h-10 w-10" />
                </div>
                <div>
                  <h2 className="text-2xl font-bold mb-2">You&apos;re All Set!</h2>
                  <p className="text-muted-foreground">Your smart account is ready. Start making onchain predictions.</p>
                </div>
                <Button onClick={() => router.push("/feed")} className="w-full">
                  Enter BackIT
                  <ArrowRight className="h-4 w-4 ml-2" />
                </Button>
              </div>
            )}
          </CardContent>
        </Card>
      </div>
    </div>
  );
}