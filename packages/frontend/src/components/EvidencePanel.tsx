"use client";

import { useState } from "react";
import { ExternalLink, Shield, ShieldCheck, FileText } from "lucide-react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/Card";
import { Badge } from "@/components/ui/Badge";
import { type ProvenanceData, formatPrice, getExplorerUrl, getIPFSUrl } from "@/lib/verify-eip712";
import { OracleSignatureInspector } from "@/src/components/OracleSignatureInspector";

interface EvidencePanelProps {
  provenance: ProvenanceData;
}

export function EvidencePanel({ provenance }: EvidencePanelProps) {
  const [inspecting, setInspecting] = useState(false);
  return (
    <Card data-testid="evidence-panel">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Shield className="h-5 w-5 text-primary" />
          Outcome Provenance
        </CardTitle>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Final Price & Outcome */}
        <div className="grid grid-cols-2 gap-4">
          <div className="bg-secondary/50 rounded-lg p-3">
            <p className="text-xs text-muted-foreground mb-1">Final Price</p>
            <p className="text-lg font-bold">{formatPrice(provenance.finalPrice)}</p>
          </div>
          <div className="bg-secondary/50 rounded-lg p-3">
            <p className="text-xs text-muted-foreground mb-1">Outcome</p>
            <p className="text-lg font-bold">{provenance.outcome}</p>
          </div>
        </div>

        {/* Oracle Address */}
        <div className="flex items-center justify-between bg-secondary/50 rounded-lg p-3">
          <div>
            <p className="text-xs text-muted-foreground mb-1">Oracle Address</p>
            <p className="font-mono text-sm break-all">{provenance.oracleAddress}</p>
          </div>
          <a
            href={getExplorerUrl(provenance.chain, provenance.oracleAddress)}
            target="_blank"
            rel="noopener noreferrer"
            className="text-primary hover:underline shrink-0 ml-2"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        </div>

        {/* Signature Info */}
        {provenance.chain === "base" && provenance.eip712Digest && (
          <div className="bg-secondary/50 rounded-lg p-3 space-y-2">
            <p className="text-xs text-muted-foreground">EIP-712 Digest</p>
            <div className="text-xs font-mono space-y-1">
              <p>Domain: {provenance.eip712Digest.domain.name} v{provenance.eip712Digest.domain.version}</p>
              <p>Chain ID: {provenance.eip712Digest.domain.chainId}</p>
              <p className="break-all">Contract: {provenance.eip712Digest.domain.verifyingContract}</p>
            </div>
          </div>
        )}

        {provenance.chain === "stellar" && provenance.stellarEvidence && (
          <div className="bg-secondary/50 rounded-lg p-3 space-y-2">
            <p className="text-xs text-muted-foreground">Ed25519 Signature</p>
            <div className="text-xs font-mono space-y-1">
              <p className="break-all">Pubkey: {provenance.stellarEvidence.pubkey}</p>
              <p className="break-all">Signature: {provenance.stellarEvidence.ed25519Signature.slice(0, 40)}...</p>
            </div>
          </div>
        )}

        {/* IPFS Evidence */}
        {provenance.evidenceCID && (
          <a
            href={getIPFSUrl(provenance.evidenceCID)}
            target="_blank"
            rel="noopener noreferrer"
            className="flex items-center gap-2 text-sm text-primary hover:underline"
          >
            <FileText className="h-4 w-4" />
            View Evidence on IPFS
            <span className="text-xs text-muted-foreground">({provenance.evidenceCID.slice(0, 12)}...)</span>
          </a>
        )}

        {/* Verification Badge */}
        <div className="flex items-center gap-2 pt-2 border-t border-border">
          {provenance.verified ? (
            <>
              <Badge tone="green">
                <ShieldCheck className="h-3 w-3 mr-1" />
                Verified
              </Badge>
              <span className="text-xs text-muted-foreground">Signature verified on-chain</span>
            </>
          ) : (
            <Badge tone="yellow">Unverified</Badge>
          )}
        </div>
        {provenance.stellarEvidence ? <button type="button" onClick={() => setInspecting(true)} className="text-xs font-medium text-primary hover:underline">Inspect raw signature</button> : null}
      </CardContent>
      {inspecting ? <OracleSignatureInspector provenance={provenance} onClose={() => setInspecting(false)} /> : null}
    </Card>
  );
}
