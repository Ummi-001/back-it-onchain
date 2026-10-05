'use client';

import * as React from 'react';
import { CheckCircle2, Copy, ExternalLink, ShieldAlert, ShieldCheck, X } from 'lucide-react';
import { dexscreenerHistoryUrl, verifyOracleEvidence, type OraclePayload, type OracleVerificationResult } from '@/src/lib/oracle-verifier';
import { getIPFSUrl, type ProvenanceData } from '@/src/lib/verify-eip712';

export interface OracleSignatureInspectorProps {
  provenance: ProvenanceData;
  payload?: OraclePayload;
  pairId?: string;
  onClose?: () => void;
}

export function OracleSignatureInspector({ provenance, payload, pairId, onClose }: OracleSignatureInspectorProps) {
  const [result, setResult] = React.useState<OracleVerificationResult | null>(null);
  const [copied, setCopied] = React.useState(false);
  const effectivePayload = payload || (provenance.stellarEvidence ? { callId: '0', outcome: provenance.outcome.toLowerCase() === 'yes', finalPrice: provenance.finalPrice, resolvedAt: 0 } : null);
  const rawJson = JSON.stringify(effectivePayload || provenance, null, 2);

  const verify = () => {
    if (!effectivePayload || !provenance.stellarEvidence) return;
    setResult(verifyOracleEvidence({ chain: 'stellar', publicKey: provenance.stellarEvidence.pubkey, signature: provenance.stellarEvidence.ed25519Signature, payload: effectivePayload, signatureEncoding: 'hex' }));
  };

  const copy = async () => {
    await navigator.clipboard?.writeText(rawJson);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <section className="fixed inset-0 z-50 flex items-center justify-center bg-black/70 p-4" role="dialog" aria-modal="true" aria-labelledby="oracle-inspector-title" data-testid="oracle-signature-inspector">
      <div className="max-h-[90vh] w-full max-w-3xl overflow-y-auto rounded-2xl border border-border bg-card p-5 shadow-2xl">
        <header className="flex items-start justify-between gap-3"><div><h2 id="oracle-inspector-title" className="text-xl font-bold">Oracle signature inspector</h2><p className="text-sm text-muted-foreground">Inspect the signed resolution payload locally.</p></div><button type="button" onClick={onClose} aria-label="Close inspector" className="rounded p-1 hover:bg-secondary"><X className="h-5 w-5" /></button></header>
        <div className="mt-4 grid gap-3 sm:grid-cols-3"><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Final price</p><p className="font-semibold">${provenance.finalPrice.toFixed(6)}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Outcome</p><p className="font-semibold">{provenance.outcome}</p></div><div className="rounded-lg bg-secondary/50 p-3"><p className="text-xs text-muted-foreground">Signer</p><p className="truncate font-mono text-xs">{provenance.stellarEvidence?.pubkey || provenance.oracleAddress}</p></div></div>
        <div className="mt-4 grid gap-3 md:grid-cols-2"><div><div className="mb-1 flex items-center justify-between text-xs text-muted-foreground"><span>Decoded payload</span><button type="button" onClick={() => void copy()} className="inline-flex items-center gap-1 hover:text-foreground">{copied ? <CheckCircle2 className="h-3.5 w-3.5 text-green-500" /> : <Copy className="h-3.5 w-3.5" />} Copy</button></div><pre className="max-h-56 overflow-auto rounded-lg bg-black/30 p-3 text-xs text-emerald-300">{rawJson}</pre></div><div><p className="mb-1 text-xs text-muted-foreground">Canonical payload</p><pre className="max-h-56 overflow-auto break-all rounded-lg bg-black/30 p-3 text-xs text-sky-300">{result?.canonicalPayload || 'Run verification to derive the canonical payload'}</pre><p className="mt-2 break-all font-mono text-[11px] text-muted-foreground">Signature: {provenance.stellarEvidence?.ed25519Signature || 'Unavailable'}</p></div></div>
        <div className="mt-4 flex flex-wrap items-center gap-2"><button type="button" onClick={verify} disabled={!provenance.stellarEvidence || !effectivePayload} className="rounded-lg bg-primary px-4 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50">Verify signature</button>{result ? <span className={`inline-flex items-center gap-1 text-sm ${result.valid ? 'text-green-500' : 'text-red-500'}`}>{result.valid ? <ShieldCheck className="h-4 w-4" /> : <ShieldAlert className="h-4 w-4" />}{result.valid ? 'Cryptographically Verified' : result.reason}</span> : null}{provenance.evidenceCID ? <a href={getIPFSUrl(provenance.evidenceCID)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">IPFS evidence <ExternalLink className="h-3.5 w-3.5" /></a> : null}{pairId ? <a href={dexscreenerHistoryUrl(pairId)} target="_blank" rel="noopener noreferrer" className="inline-flex items-center gap-1 text-sm text-primary hover:underline">Historical chart <ExternalLink className="h-3.5 w-3.5" /></a> : null}</div>
        {!provenance.stellarEvidence ? <p className="mt-4 text-xs text-muted-foreground">This resolution has no Ed25519 evidence to verify.</p> : null}
      </div>
    </section>
  );
}

export default OracleSignatureInspector;
