'use client';

import * as React from 'react';
import { Check, Copy, Download, Share2 } from 'lucide-react';
import { toast } from 'sonner';
import { copySocialCard, createSocialCardBlob, downloadBlob, renderSocialCard, SOCIAL_CARD_HEIGHT, SOCIAL_CARD_WIDTH, type SocialCardData } from '@/src/lib/canvas-share';

export interface SocialCardGeneratorProps {
  data: SocialCardData;
  className?: string;
}

export function SocialCardGenerator({ data, className }: SocialCardGeneratorProps) {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const [isWorking, setIsWorking] = React.useState(false);
  const [copied, setCopied] = React.useState(false);

  React.useEffect(() => {
    if (canvasRef.current) renderSocialCard(canvasRef.current, data);
  }, [data]);

  const makeBlob = async () => createSocialCardBlob(data);

  const download = async () => {
    setIsWorking(true);
    try {
      downloadBlob(await makeBlob(), 'back-it-onchain-call.png');
      toast.success('Social card downloaded.');
    } catch {
      toast.error('Could not create the social card.');
    } finally {
      setIsWorking(false);
    }
  };

  const copy = async () => {
    setIsWorking(true);
    try {
      const blob = await makeBlob();
      const success = await copySocialCard(blob);
      if (!success) throw new Error('Clipboard image unsupported');
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2000);
      toast.success('Card copied to clipboard.');
    } catch {
      toast.error('Image clipboard is unavailable; download the card instead.');
    } finally {
      setIsWorking(false);
    }
  };

  const share = async () => {
    const url = data.url || (typeof window !== 'undefined' ? window.location.href : '');
    if (navigator.share) {
      await navigator.share({ title: data.title, text: `Check out ${data.title}`, url }).catch(() => undefined);
      return;
    }
    await copy();
  };

  return (
    <section className={className} data-testid="social-card-generator">
      <canvas ref={canvasRef} width={SOCIAL_CARD_WIDTH} height={SOCIAL_CARD_HEIGHT} className="hidden" aria-label="Generated social card preview" />
      <div className="flex flex-wrap gap-2">
        <button type="button" onClick={() => void download()} disabled={isWorking} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary disabled:opacity-50"><Download className="h-4 w-4" /> Download PNG</button>
        <button type="button" onClick={() => void copy()} disabled={isWorking} className="inline-flex items-center gap-2 rounded-lg border border-border px-3 py-2 text-sm hover:bg-secondary disabled:opacity-50">{copied ? <Check className="h-4 w-4 text-green-500" /> : <Copy className="h-4 w-4" />} {copied ? 'Copied' : 'Copy image'}</button>
        <button type="button" onClick={() => void share()} disabled={isWorking} className="inline-flex items-center gap-2 rounded-lg bg-primary px-3 py-2 text-sm font-semibold text-primary-foreground disabled:opacity-50"><Share2 className="h-4 w-4" /> Share</button>
      </div>
    </section>
  );
}

export default SocialCardGenerator;
