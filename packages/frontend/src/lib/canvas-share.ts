export interface SocialCardData {
  title: string;
  creator?: string;
  token?: string;
  target?: string;
  yesPercent?: number;
  noPercent?: number;
  url?: string;
}

export const SOCIAL_CARD_WIDTH = 1200;
export const SOCIAL_CARD_HEIGHT = 630;

function roundedRect(context: CanvasRenderingContext2D, x: number, y: number, width: number, height: number, radius: number): void {
  context.beginPath();
  context.moveTo(x + radius, y);
  context.arcTo(x + width, y, x + width, y + height, radius);
  context.arcTo(x + width, y + height, x, y + height, radius);
  context.arcTo(x, y + height, x, y, radius);
  context.arcTo(x, y, x + width, y, radius);
  context.closePath();
}

export function renderSocialCard(canvas: HTMLCanvasElement, data: SocialCardData): void {
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas is not available');
  canvas.width = SOCIAL_CARD_WIDTH;
  canvas.height = SOCIAL_CARD_HEIGHT;
  const gradient = context.createLinearGradient(0, 0, SOCIAL_CARD_WIDTH, SOCIAL_CARD_HEIGHT);
  gradient.addColorStop(0, '#09090b');
  gradient.addColorStop(1, '#172554');
  context.fillStyle = gradient;
  context.fillRect(0, 0, SOCIAL_CARD_WIDTH, SOCIAL_CARD_HEIGHT);
  context.fillStyle = 'rgba(56,189,248,0.16)';
  roundedRect(context, 56, 56, SOCIAL_CARD_WIDTH - 112, 100, 22);
  context.fill();
  context.font = '700 28px Arial, sans-serif';
  context.fillStyle = '#e0f2fe';
  context.fillText('BACK IT ONCHAIN', 88, 116);
  context.font = '700 52px Arial, sans-serif';
  context.fillStyle = '#f8fafc';
  const title = data.title.length > 42 ? `${data.title.slice(0, 39)}…` : data.title;
  context.fillText(title, 72, 250, 1050);
  context.font = '400 30px Arial, sans-serif';
  context.fillStyle = '#cbd5e1';
  context.fillText(`${data.token || 'Market'} · ${data.target || 'Target pending'}`, 76, 316);
  const yes = Math.max(0, Math.min(100, data.yesPercent ?? 50));
  const barY = 380;
  context.fillStyle = '#ef4444';
  roundedRect(context, 76, barY, 1048, 28, 14);
  context.fill();
  context.fillStyle = '#22c55e';
  roundedRect(context, 76, barY, 1048 * (yes / 100), 28, 14);
  context.fill();
  context.font = '700 26px Arial, sans-serif';
  context.fillStyle = '#f8fafc';
  context.fillText(`YES ${yes.toFixed(0)}%`, 76, 454);
  context.fillStyle = '#fda4af';
  context.fillText(`NO ${(100 - yes).toFixed(0)}%`, 1010, 454);
  context.font = '400 24px Arial, sans-serif';
  context.fillStyle = '#94a3b8';
  context.fillText(`by ${data.creator || 'Anonymous predictor'}`, 76, 550);
}

export async function createSocialCardBlob(data: SocialCardData): Promise<Blob> {
  if (typeof document === 'undefined') throw new Error('Social cards require a browser');
  const canvas = document.createElement('canvas');
  renderSocialCard(canvas, data);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => blob ? resolve(blob) : reject(new Error('Could not encode social card')), 'image/png');
  });
}

export async function copySocialCard(blob: Blob): Promise<boolean> {
  if (typeof ClipboardItem === 'undefined' || !navigator.clipboard?.write) return false;
  try {
    await navigator.clipboard.write([new ClipboardItem({ 'image/png': blob })]);
    return true;
  } catch {
    return false;
  }
}

export function downloadBlob(blob: Blob, filename: string): void {
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
}
