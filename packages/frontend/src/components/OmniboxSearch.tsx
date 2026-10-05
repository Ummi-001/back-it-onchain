'use client';

import * as React from 'react';
import { useRouter } from 'next/navigation';
import * as Dialog from '@radix-ui/react-dialog';
import { ArrowDown, ArrowUp, Clock3, Search, X } from 'lucide-react';
import { useOmniSearch, type OmniResult, type UseOmniSearchOptions } from '@/src/hooks/useOmniSearch';

export interface OmniboxSearchProps extends UseOmniSearchOptions {
  buttonLabel?: string;
}

const groupLabels: Record<OmniResult['type'], string> = {
  user: 'Profiles',
  call: 'Calls',
  token: 'Tokens',
  staker: 'Stakers',
  tag: 'Tags',
  category: 'Categories',
};

export function OmniboxSearch({ buttonLabel = 'Search', ...options }: OmniboxSearchProps) {
  const router = useRouter();
  const inputRef = React.useRef<HTMLInputElement | null>(null);
  const [open, setOpen] = React.useState(false);
  const [query, setQuery] = React.useState('');
  const [activeIndex, setActiveIndex] = React.useState(0);
  const { results, recent, isLoading, error, clearRecent } = useOmniSearch(query, options);
  const groups = React.useMemo(() => {
    const map = new Map<OmniResult['type'], OmniResult[]>();
    for (const result of results) map.set(result.type, [...(map.get(result.type) || []), result]);
    return map;
  }, [results]);

  React.useEffect(() => {
    const handler = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'k') {
        event.preventDefault();
        setOpen((current) => !current);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, []);

  React.useEffect(() => {
    if (open) window.setTimeout(() => inputRef.current?.focus(), 20);
    else { setQuery(''); setActiveIndex(0); }
  }, [open]);

  React.useEffect(() => setActiveIndex(0), [query]);

  const navigate = (result: OmniResult) => {
    setOpen(false);
    router.push(result.href);
  };

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'ArrowDown') { event.preventDefault(); setActiveIndex((index) => Math.min(index + 1, results.length - 1)); }
    if (event.key === 'ArrowUp') { event.preventDefault(); setActiveIndex((index) => Math.max(index - 1, 0)); }
    if (event.key === 'Enter' && results[activeIndex]) { event.preventDefault(); navigate(results[activeIndex]); }
  };

  let optionIndex = -1;

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-border px-3 py-2 text-sm text-muted-foreground hover:bg-secondary" aria-label={buttonLabel}><Search className="mr-1 inline h-4 w-4" />{buttonLabel}<kbd className="ml-2 rounded border border-border px-1 text-[10px]">⌘K</kbd></button>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm" />
        <Dialog.Content className="fixed left-1/2 top-[15%] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-2xl border border-border bg-card shadow-2xl">
          <Dialog.Title className="sr-only">Search Back It Onchain</Dialog.Title>
          <Dialog.Description className="sr-only">Search profiles, calls, tokens, stakers, tags, and categories.</Dialog.Description>
          <div className="flex items-center gap-2 border-b border-border px-4 py-3">
            <Search className="h-5 w-5 text-muted-foreground" />
            <input ref={inputRef} value={query} onChange={(event) => setQuery(event.target.value)} onKeyDown={onKeyDown} placeholder="Search calls, tokens, profiles…" className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" role="combobox" aria-expanded="true" aria-controls="omnibox-results" aria-activedescendant={results[activeIndex] ? `omnibox-${results[activeIndex].id}` : undefined} />
            <Dialog.Close asChild><button type="button" aria-label="Close search"><X className="h-4 w-4 text-muted-foreground" /></button></Dialog.Close>
          </div>
          <div id="omnibox-results" role="listbox" className="max-h-96 overflow-y-auto p-2">
            {!query && recent.length > 0 ? <div className="mb-2 flex items-center justify-between px-2 text-xs text-muted-foreground"><span className="inline-flex items-center gap-1"><Clock3 className="h-3.5 w-3.5" /> Recent</span><button type="button" onClick={clearRecent} className="underline">Clear</button></div> : null}
            {!query && recent.map((entry) => <button key={entry} type="button" onClick={() => setQuery(entry)} className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left text-sm hover:bg-secondary"><Clock3 className="h-3.5 w-3.5 text-muted-foreground" />{entry}</button>)}
            {isLoading ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">Searching…</p> : null}
            {error ? <p className="px-3 py-6 text-center text-sm text-red-500" role="alert">Search unavailable.</p> : null}
            {!isLoading && query && results.length === 0 ? <p className="px-3 py-6 text-center text-sm text-muted-foreground">No matches for “{query}”.</p> : null}
            {[...groups.entries()].map(([type, items]) => <div key={type} className="mb-2"><p className="px-2 py-1 text-[10px] font-semibold uppercase tracking-wider text-muted-foreground">{groupLabels[type]}</p>{items.map((result) => { optionIndex += 1; const index = optionIndex; return <button key={`${result.type}-${result.id}`} id={`omnibox-${result.id}`} role="option" aria-selected={index === activeIndex} type="button" onMouseEnter={() => setActiveIndex(index)} onClick={() => navigate(result)} className={`flex w-full items-center gap-3 rounded-lg px-3 py-2 text-left ${index === activeIndex ? 'bg-secondary' : 'hover:bg-secondary'}`}><span className="text-sm">{result.label}</span>{result.sublabel ? <span className="truncate text-xs text-muted-foreground">{result.sublabel}</span> : null}</button>; })}</div>)}
          </div>
          <div className="flex items-center gap-3 border-t border-border px-4 py-2 text-[10px] text-muted-foreground"><span className="inline-flex items-center gap-1"><ArrowUp className="h-3 w-3" /><ArrowDown className="h-3 w-3" /> navigate</span><span>↵ open</span><span>esc close</span></div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

export default OmniboxSearch;
