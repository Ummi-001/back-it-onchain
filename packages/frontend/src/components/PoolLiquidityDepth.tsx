'use client';

import * as React from 'react';
import { Activity, ArrowDownRight, ArrowUpRight } from 'lucide-react';
import type { CallPool } from '@/src/hooks/useCallLive';

export interface DepthPoint {
  timestamp: number;
  yes: number;
  no: number;
}

export interface PoolLiquidityDepthProps {
  pool: CallPool;
  history?: DepthPoint[];
  height?: number;
  className?: string;
}

function scale(value: number, max: number, height: number, padding: number): number {
  return height - padding - (max === 0 ? 0 : (value / max) * (height - padding * 2));
}

function pathFor(values: number[], width: number, height: number, max: number, padding: number): string {
  if (values.length === 0) return '';
  return values.map((value, index) => {
    const x = values.length === 1 ? width / 2 : (index / (values.length - 1)) * width;
    const y = scale(value, max, height, padding);
    return `${index === 0 ? 'M' : 'L'}${x.toFixed(2)},${y.toFixed(2)}`;
  }).join(' ');
}

export function PoolLiquidityDepth({ pool, history = [], height = 180, className }: PoolLiquidityDepthProps) {
  const width = 640;
  const padding = 18;
  const points = React.useMemo(() => {
    const current = { timestamp: Date.now(), yes: pool.yesTotal, no: pool.noTotal };
    return [...history, current].slice(-60);
  }, [history, pool.noTotal, pool.yesTotal]);
  const max = Math.max(1, ...points.flatMap((point) => [point.yes, point.no]));
  const yesPath = pathFor(points.map((point) => point.yes), width, height, max, padding);
  const noPath = pathFor(points.map((point) => point.no), width, height, max, padding);
  const total = pool.yesTotal + pool.noTotal;
  const weightedYes = points.reduce((sum, point) => sum + point.yes, 0);
  const weightedNo = points.reduce((sum, point) => sum + point.no, 0);
  const weightedTotal = weightedYes + weightedNo;
  const dominance = total === 0 ? 50 : (pool.yesTotal / total) * 100;
  const last = points[points.length - 1];
  const previous = points[points.length - 2] || last;
  const delta = last && previous ? last.yes - previous.yes : 0;

  return (
    <section className={className} aria-label="Live staking pool liquidity depth">
      <div className="mb-2 flex items-center justify-between text-xs text-muted-foreground">
        <span className="inline-flex items-center gap-1"><Activity className="h-3.5 w-3.5 text-primary" /> Order flow</span>
        <span className={delta >= 0 ? 'text-green-500' : 'text-red-500'}>{delta >= 0 ? <ArrowUpRight className="inline h-3.5 w-3.5" /> : <ArrowDownRight className="inline h-3.5 w-3.5" />}{Math.abs(delta).toFixed(0)} latest YES flow</span>
      </div>
      <svg viewBox={`0 0 ${width} ${height}`} width="100%" height={height} role="img" aria-label="Stepped YES and NO liquidity depth chart" preserveAspectRatio="none">
        <line x1="0" y1={height - padding} x2={width} y2={height - padding} stroke="currentColor" className="text-border" />
        <path d={yesPath} fill="none" stroke="#22c55e" strokeWidth={3} strokeLinejoin="round" />
        <path d={noPath} fill="none" stroke="#ef4444" strokeWidth={3} strokeLinejoin="round" />
      </svg>
      <div className="mt-2 grid grid-cols-3 gap-2 text-xs">
        <div><p className="text-muted-foreground">YES dominance</p><p className="font-semibold text-green-500">{dominance.toFixed(1)}%</p></div>
        <div><p className="text-muted-foreground">VWAP YES</p><p className="font-semibold">{weightedTotal === 0 ? '—' : (weightedYes / points.length).toFixed(2)}</p></div>
        <div><p className="text-muted-foreground">VWAP NO</p><p className="font-semibold">{weightedTotal === 0 ? '—' : (weightedNo / points.length).toFixed(2)}</p></div>
      </div>
    </section>
  );
}

export default PoolLiquidityDepth;
