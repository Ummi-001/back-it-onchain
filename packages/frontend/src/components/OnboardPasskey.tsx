'use client';

import { useRef, useState } from 'react';
import { CheckCircle2, KeyRound, Loader2, ShieldAlert } from 'lucide-react';
import { Button } from '@/components/ui/Button';
import { isPasskeySupported, PasskeyStellarAdapter, type PasskeyCredentialRecord } from '@/src/lib/passkey-stellar';

interface OnboardPasskeyProps {
  onComplete: (walletAddress: string) => void;
  onFallback?: () => void;
  resolveAccount?: (result: { accountHandle: string; credential: PasskeyCredentialRecord }) => Promise<string> | string;
}

export function OnboardPasskey({ onComplete, onFallback, resolveAccount }: OnboardPasskeyProps) {
  const adapter = useRef(new PasskeyStellarAdapter());
  const [isCreating, setIsCreating] = useState(false);
  const [created, setCreated] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleCreatePasskey = async () => {
    setIsCreating(true);
    setError(null);
    try {
      if (!isPasskeySupported()) throw new Error('This browser does not support passkeys. Use a hardware or browser wallet instead.');
      const result = await adapter.current.createAccount('backit-onchain-user');
      const walletAddress = await (resolveAccount ? resolveAccount(result) : result.accountHandle);
      setCreated(true);
      onComplete(walletAddress);
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : String(caught));
    } finally {
      setIsCreating(false);
    }
  };

  return (
    <div className="space-y-6 animate-in fade-in slide-in-from-bottom-4">
      <div className="text-center"><h2 className="text-2xl font-bold mb-2">Create Passkey</h2><p className="text-muted-foreground">Set up a passkey for secure, passwordless authentication.</p></div>
      <div className="flex justify-center"><div className={`h-24 w-24 rounded-full flex items-center justify-center transition-all ${created ? 'bg-green-500/20 text-green-500' : 'bg-secondary border-2 border-dashed border-muted-foreground/50'}`}>{created ? <CheckCircle2 className="h-10 w-10" /> : <KeyRound className="h-10 w-10 text-muted-foreground" />}</div></div>
      <div className="bg-secondary/50 rounded-lg p-4 border border-border space-y-2"><p className="text-sm font-medium">What is a passkey?</p><ul className="text-xs text-muted-foreground space-y-1"><li>• Passwordless sign-in using biometrics or PIN</li><li>• Secured by your device&apos;s hardware</li><li>• No seed phrase to remember</li></ul></div>
      {error ? <p className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/5 p-3 text-xs text-amber-600" role="alert"><ShieldAlert className="h-4 w-4 shrink-0" />{error}</p> : null}
      <Button onClick={handleCreatePasskey} disabled={isCreating || created} className="w-full">{isCreating ? <><Loader2 className="h-5 w-5 animate-spin mr-2" /> Creating Passkey...</> : created ? 'Passkey Created' : 'Create Passkey'}</Button>
      {onFallback ? <button type="button" onClick={onFallback} className="w-full text-center text-xs text-muted-foreground underline">Use a hardware or browser wallet instead</button> : null}
    </div>
  );
}
