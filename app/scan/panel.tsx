'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import Image from 'next/image';
import type { CatalogItem } from '@/lib/agent/catalog';
import type { AgentContext } from './scan-layout';

type Tab = 'chat' | 'catalog' | 'prompt' | 'debug';

type ChatEvent =
  | { type: 'tool_call'; id: string; name: string; input: unknown; t: number }
  | { type: 'tool_result'; id: string; result: unknown; t: number }
  | { type: 'thinking'; text: string; t: number }
  | { type: 'assistant_message'; text: string; t: number }
  | { type: 'loop_aborted'; reason: string; t: number }
  | { type: 'error'; message: string; t?: number };

type ModelChoice = 'sonnet' | 'opus';

export default function AgentPanel({
  ctx,
  onRefresh,
  onCatalogDragStart,
  onCatalogDragEnd,
}: {
  ctx: AgentContext | null;
  onRefresh: () => void;
  onCatalogDragStart?: (id: string) => void;
  onCatalogDragEnd?: () => void;
}) {
  const [tab, setTab] = useState<Tab>('chat');
  const [rolePromptDraft, setRolePromptDraft] = useState('');

  // Seed the role-prompt textarea once we have context.
  useEffect(() => {
    if (ctx && !rolePromptDraft) setRolePromptDraft(ctx.defaultRolePrompt);
  }, [ctx, rolePromptDraft]);

  return (
    <aside className="flex w-[440px] shrink-0 flex-col border-l border-neutral-300 bg-white text-neutral-900">
      <div className="flex items-center justify-between border-b border-neutral-200 bg-neutral-50/80 px-2 py-1">
        <div className="text-[10px] font-medium uppercase tracking-wider text-neutral-500">
          {ctx?.placements.length ?? 0} placement{ctx?.placements.length === 1 ? '' : 's'}
          {ctx?.design && (ctx.design.assignmentCount > 0 || ctx.design.hasOutcome) && (
            <span className="ml-1 text-amber-700">
              · {ctx.design.assignmentCount} in design
            </span>
          )}
        </div>
        <button
          onClick={async () => {
            const has =
              (ctx?.placements.length ?? 0) > 0 ||
              (ctx?.design?.assignmentCount ?? 0) > 0 ||
              ctx?.design?.hasOutcome;
            if (!has) return;
            await fetch('/api/placements', { method: 'DELETE' });
            onRefresh();
          }}
          disabled={
            !ctx ||
            ((ctx.placements.length ?? 0) === 0 &&
              (ctx.design?.assignmentCount ?? 0) === 0 &&
              !ctx.design?.hasOutcome)
          }
          title="Wipe placements, design intent, and last solve outcome"
          className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-medium text-white transition hover:bg-red-700 disabled:bg-neutral-200 disabled:text-neutral-400"
        >
          reset
        </button>
      </div>
      <div className="flex border-b border-neutral-200 bg-neutral-50/80">
        {(['chat', 'catalog', 'prompt', 'debug'] as Tab[]).map((t) => (
          <button
            key={t}
            onClick={() => setTab(t)}
            className={
              'flex-1 px-3 py-2 text-xs font-medium uppercase tracking-wider transition ' +
              (tab === t
                ? 'bg-white text-neutral-900 border-b-2 border-neutral-900'
                : 'text-neutral-500 hover:bg-neutral-100')
            }
          >
            {t}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'chat' && (
          <ChatTab
            rolePromptOverride={rolePromptDraft !== ctx?.defaultRolePrompt ? rolePromptDraft : undefined}
            onTurnComplete={onRefresh}
          />
        )}
        {tab === 'catalog' && (
          <CatalogTab
            catalog={ctx?.catalog ?? []}
            onDragStart={onCatalogDragStart}
            onDragEnd={onCatalogDragEnd}
          />
        )}
        {tab === 'prompt' && (
          <PromptTab ctx={ctx} draft={rolePromptDraft} setDraft={setRolePromptDraft} />
        )}
        {tab === 'debug' && <DebugTab ctx={ctx} />}
      </div>
    </aside>
  );
}

// ------------------------------- Chat -------------------------------

function ChatTab({
  rolePromptOverride,
  onTurnComplete,
}: {
  rolePromptOverride?: string;
  onTurnComplete: () => void;
}) {
  const [input, setInput] = useState(
    'Place a small reading nook with a warm-wood lounge chair under $1500 total. Use query_space first.'
  );
  const [events, setEvents] = useState<ChatEvent[]>([]);
  const [streaming, setStreaming] = useState(false);
  const [model, setModel] = useState<ModelChoice>('sonnet');
  const [thinkingOn, setThinkingOn] = useState(false);
  const [thinkingBudget, setThinkingBudget] = useState(5000);
  /** Cap on agent ↔ tool round-trips per turn. Bump for hard placement
   *  problems where the agent needs many ADD/SOLVE retry cycles. */
  const [maxToolIterations, setMaxToolIterations] = useState(24);
  const scrollerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  async function send() {
    if (!input.trim() || streaming) return;
    setEvents([]);
    setStreaming(true);
    try {
      console.log('[ChatTab] Sending to /api/chat…', input.slice(0, 80));
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: input,
          rolePromptOverride,
          model,
          thinkingBudget: thinkingOn ? thinkingBudget : 0,
          maxToolIterations,
        }),
      });
      console.log('[ChatTab] Response status:', res.status, res.statusText);
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        console.error('[ChatTab] Non-OK response:', res.status, text);
        setEvents((e) => [...e, { type: 'error', message: `HTTP ${res.status}: ${text || res.statusText}` }]);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let frameCount = 0;
      while (true) {
        const { done, value } = await reader.read();
        if (done) {
          console.log('[ChatTab] Stream ended. Total SSE frames parsed:', frameCount);
          break;
        }
        buffer += decoder.decode(value, { stream: true });
        // SSE frames: `event: TYPE\ndata: <json>\n\n`
        let idx;
        while ((idx = buffer.indexOf('\n\n')) !== -1) {
          const frame = buffer.slice(0, idx);
          buffer = buffer.slice(idx + 2);
          const dataLine = frame.split('\n').find((l) => l.startsWith('data: '));
          if (!dataLine) continue;
          try {
            const parsed = JSON.parse(dataLine.slice(6)) as ChatEvent;
            frameCount++;
            console.log('[ChatTab] SSE frame', frameCount, '→', parsed.type, 'name' in parsed ? (parsed as { name: string }).name : '');
            setEvents((e) => [...e, parsed]);
          } catch (err) {
            console.error('[ChatTab] bad SSE frame', frame, err);
            setEvents((e) => [...e, { type: 'error', message: `Bad SSE frame: ${frame.slice(0, 200)}` }]);
          }
        }
      }
      if (frameCount === 0) {
        console.warn('[ChatTab] Stream ended with 0 SSE frames \u2014 the agent may have failed silently');
        setEvents((e) => [...e, { type: 'error', message: 'Stream ended with no events \u2014 check the terminal for server-side errors' }]);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[ChatTab] fetch threw:', msg);
      setEvents((evts) => [
        ...evts,
        { type: 'error', message: msg },
      ]);
    } finally {
      setStreaming(false);
      onTurnComplete();
    }
  }

  return (
    <div className="flex h-full flex-col">
      <div ref={scrollerRef} className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-xs">
        {events.length === 0 && !streaming && (
          <div className="rounded border border-dashed border-neutral-300 p-6 text-center text-neutral-500">
            Ask the agent something. Tool calls stream live as they fire.
          </div>
        )}
        {events.map((e, i) => (
          <EventCard key={i} event={e} />
        ))}
        {streaming && <div className="animate-pulse text-neutral-500">streaming…</div>}
      </div>
      <div className="border-t border-neutral-200 bg-neutral-50/60 p-2">
        <textarea
          value={input}
          onChange={(e) => setInput(e.target.value)}
          rows={3}
          className="w-full resize-none rounded border border-neutral-300 bg-white p-2 text-xs focus:border-neutral-500 focus:outline-none"
          placeholder="What would you like the agent to do?"
          disabled={streaming}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[10px]">
            <select
              value={model}
              onChange={(e) => setModel(e.target.value as ModelChoice)}
              disabled={streaming}
              className="rounded border border-neutral-300 bg-white px-1.5 py-0.5 font-medium text-neutral-800 disabled:opacity-40"
            >
              <option value="sonnet">Sonnet 4.6</option>
              <option value="opus">Opus 4.7</option>
            </select>
            <label className="flex items-center gap-1 text-neutral-600">
              <input
                type="checkbox"
                checked={thinkingOn}
                onChange={(e) => setThinkingOn(e.target.checked)}
                disabled={streaming}
                className="h-3 w-3"
              />
              think
            </label>
            {thinkingOn && (
              <input
                type="number"
                value={thinkingBudget}
                onChange={(e) => setThinkingBudget(Math.max(1024, Number(e.target.value) || 5000))}
                step={1000}
                min={1024}
                max={32000}
                disabled={streaming}
                className="w-16 rounded border border-neutral-300 bg-white px-1 py-0.5 font-mono text-neutral-800 disabled:opacity-40"
              />
            )}
            <label className="flex items-center gap-1 text-neutral-600" title="Max agent ↔ tool round-trips per turn (4–64)">
              <span>iters</span>
              <input
                type="number"
                value={maxToolIterations}
                onChange={(e) =>
                  setMaxToolIterations(
                    Math.min(64, Math.max(4, Number(e.target.value) || 24))
                  )
                }
                step={4}
                min={4}
                max={64}
                disabled={streaming}
                className="w-12 rounded border border-neutral-300 bg-white px-1 py-0.5 font-mono text-neutral-800 disabled:opacity-40"
              />
            </label>
            {rolePromptOverride && (
              <span className="text-amber-700">role-prompt overridden</span>
            )}
          </div>
          <button
            onClick={send}
            disabled={streaming || !input.trim()}
            className="rounded bg-neutral-900 px-4 py-1.5 text-xs font-medium text-white disabled:opacity-40"
          >
            {streaming ? 'streaming…' : 'Send'}
          </button>
        </div>
      </div>
    </div>
  );
}

function EventCard({ event }: { event: ChatEvent }) {
  if (event.type === 'tool_call') {
    return (
      <div className="rounded border border-blue-200 bg-blue-50/60 p-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] font-semibold text-blue-900">→ {event.name}</span>
          <span className="text-[10px] text-blue-600">+{event.t}ms</span>
        </div>
        <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-all text-[10px] text-blue-900/80">
          {JSON.stringify(event.input, null, 2)}
        </pre>
      </div>
    );
  }
  if (event.type === 'tool_result') {
    const json = JSON.stringify(event.result, null, 2);
    return (
      <div className="rounded border border-emerald-200 bg-emerald-50/40 p-2">
        <div className="flex items-center justify-between">
          <span className="font-mono text-[11px] font-semibold text-emerald-900">← result</span>
          <span className="text-[10px] text-emerald-700">+{event.t}ms</span>
        </div>
        <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap break-all text-[10px] text-emerald-900/80">
          {json}
        </pre>
      </div>
    );
  }
  if (event.type === 'thinking') {
    return (
      <div className="rounded border border-purple-200 bg-purple-50/40 p-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="text-[10px] font-semibold uppercase tracking-wider text-purple-700">
            thinking
          </span>
          <span className="text-[10px] text-purple-600">+{event.t}ms</span>
        </div>
        <div className="whitespace-pre-wrap text-[11px] italic leading-relaxed text-purple-900/80">
          {event.text}
        </div>
      </div>
    );
  }
  if (event.type === 'assistant_message') {
    return (
      <div className="rounded border border-neutral-300 bg-white p-2">
        <div className="mb-1 text-[10px] font-semibold uppercase tracking-wider text-neutral-500">
          assistant
        </div>
        <div className="whitespace-pre-wrap text-xs text-neutral-900">{event.text}</div>
      </div>
    );
  }
  if (event.type === 'loop_aborted') {
    return (
      <div className="rounded border border-amber-300 bg-amber-50 p-2 text-[11px] text-amber-900">
        <span className="font-semibold">loop aborted:</span> {event.reason}
      </div>
    );
  }
  if (event.type === 'error') {
    return (
      <div className="rounded border border-red-300 bg-red-50 p-2 text-[11px] text-red-900">
        <span className="font-semibold">error:</span> {event.message}
      </div>
    );
  }
  return null;
}

// ------------------------------ Catalog ------------------------------

type SortMode = 'default' | 'price_asc' | 'price_desc';

function CatalogTab({
  catalog,
  onDragStart,
  onDragEnd,
}: {
  catalog: CatalogItem[];
  onDragStart?: (id: string) => void;
  onDragEnd?: () => void;
}) {
  const [query, setQuery] = useState('');
  const [category, setCategory] = useState<string>('all');
  const [sortMode, setSortMode] = useState<SortMode>('default');
  const [menuOpen, setMenuOpen] = useState(false);
  const [sortOpen, setSortOpen] = useState(false);
  const menuRef = useRef<HTMLDivElement | null>(null);
  const sortRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!menuOpen) return;
    function onClick(e: MouseEvent) {
      if (menuRef.current && !menuRef.current.contains(e.target as Node)) {
        setMenuOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [menuOpen]);

  useEffect(() => {
    if (!sortOpen) return;
    function onClick(e: MouseEvent) {
      if (sortRef.current && !sortRef.current.contains(e.target as Node)) {
        setSortOpen(false);
      }
    }
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, [sortOpen]);

  const counts = useMemo(() => {
    const c = new Map<string, number>();
    for (const item of catalog) c.set(item.category, (c.get(item.category) ?? 0) + 1);
    return c;
  }, [catalog]);

  const filtered = catalog.filter((item) => {
    if (category !== 'all' && item.category !== category) return false;
    if (!query) return true;
    const hay = `${item.name} ${item.brand} ${item.category} ${item.color} ${item.material.join(' ')}`.toLowerCase();
    return hay.includes(query.toLowerCase());
  });

  // Sort runs on every render against the live `catalog` prop, so manual
  // price edits (after the in-memory cache is bypassed) re-order immediately.
  const sorted = sortMode === 'default' ? filtered : [...filtered].sort((a, b) => {
    const ap = a.price_usd ?? Number.POSITIVE_INFINITY;
    const bp = b.price_usd ?? Number.POSITIVE_INFINITY;
    return sortMode === 'price_asc' ? ap - bp : bp - ap;
  });

  const categoryLabel = category === 'all' ? `All (${catalog.length})` : `${prettyCategory(category)} (${counts.get(category) ?? 0})`;
  const sortLabel =
    sortMode === 'price_asc' ? 'Price ↑' :
    sortMode === 'price_desc' ? 'Price ↓' : 'Sort';

  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-200 bg-neutral-50/60 p-3">
        <div className="flex gap-2">
          <input
            type="text"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Search…"
            className="flex-1 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs focus:border-neutral-500 focus:outline-none"
          />
          <div ref={sortRef} className="relative">
            <button
              type="button"
              onClick={() => setSortOpen((v) => !v)}
              className="flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:border-neutral-400"
            >
              {sortLabel}
              <span className="text-neutral-400">▾</span>
            </button>
            {sortOpen && (
              <div className="absolute right-0 top-full z-10 mt-1 w-40 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg">
                {([
                  ['default', 'Default'],
                  ['price_asc', 'Price: Low → High'],
                  ['price_desc', 'Price: High → Low'],
                ] as Array<[SortMode, string]>).map(([mode, label]) => (
                  <button
                    type="button"
                    key={mode}
                    onClick={() => {
                      setSortMode(mode);
                      setSortOpen(false);
                    }}
                    className={`flex w-full items-center px-3 py-1.5 text-left text-xs hover:bg-neutral-50 ${
                      sortMode === mode ? 'font-medium text-neutral-900' : 'text-neutral-700'
                    }`}
                  >
                    {label}
                  </button>
                ))}
              </div>
            )}
          </div>
          <div ref={menuRef} className="relative">
            <button
              type="button"
              onClick={() => setMenuOpen((v) => !v)}
              className="flex items-center gap-1 rounded-md border border-neutral-300 bg-white px-3 py-1.5 text-xs text-neutral-700 hover:border-neutral-400"
            >
              {categoryLabel}
              <span className="text-neutral-400">▾</span>
            </button>
            {menuOpen && (
              <div className="absolute right-0 top-full z-10 mt-1 w-44 overflow-hidden rounded-md border border-neutral-200 bg-white shadow-lg">
                <button
                  type="button"
                  onClick={() => {
                    setCategory('all');
                    setMenuOpen(false);
                  }}
                  className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-neutral-50 ${
                    category === 'all' ? 'font-medium text-neutral-900' : 'text-neutral-700'
                  }`}
                >
                  <span>All</span>
                  <span className="text-neutral-400">{catalog.length}</span>
                </button>
                {[...counts.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .map(([cat, n]) => (
                    <button
                      type="button"
                      key={cat}
                      onClick={() => {
                        setCategory(cat);
                        setMenuOpen(false);
                      }}
                      className={`flex w-full items-center justify-between px-3 py-1.5 text-left text-xs hover:bg-neutral-50 ${
                        category === cat ? 'font-medium text-neutral-900' : 'text-neutral-700'
                      }`}
                    >
                      <span>{prettyCategory(cat)}</span>
                      <span className="text-neutral-400">{n}</span>
                    </button>
                  ))}
              </div>
            )}
          </div>
        </div>
        <div className="mt-1.5 text-[10px] text-neutral-500">
          {sorted.length} / {catalog.length} items · drag a card into the room
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-3 overflow-y-auto p-3">
        {sorted.map((item) => (
          <CatalogCard
            key={item.id}
            item={item}
            onDragStart={onDragStart}
            onDragEnd={onDragEnd}
          />
        ))}
      </div>
    </div>
  );
}

function prettyCategory(c: string): string {
  return c.charAt(0).toUpperCase() + c.slice(1);
}

function CatalogCard({
  item,
  onDragStart,
  onDragEnd,
}: {
  item: CatalogItem;
  onDragStart?: (id: string) => void;
  onDragEnd?: () => void;
}) {
  const subtitle = buildSubtitle(item);
  return (
    <div
      draggable
      onDragStart={(e) => {
        e.dataTransfer.setData('application/x-catalog-item', item.id);
        e.dataTransfer.effectAllowed = 'copy';
        onDragStart?.(item.id);
      }}
      onDragEnd={() => onDragEnd?.()}
      className="flex cursor-grab select-none items-stretch gap-3 rounded-lg border border-neutral-200 bg-white p-3 hover:border-neutral-300 active:cursor-grabbing">
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="text-sm font-medium leading-tight text-neutral-900">{item.name}</div>
        {subtitle && (
          <div className="mt-1 truncate text-[11px] text-neutral-500">{subtitle}</div>
        )}
        <div className="mt-auto space-y-0.5 pt-3">
          <div className="font-mono text-sm text-neutral-900">
            {item.price_usd != null ? `$${item.price_usd}` : '—'}
          </div>
          {item.asin && (
            <a
              href={`https://www.amazon.com/dp/${item.asin}`}
              target="_blank"
              rel="noopener noreferrer"
              className="block text-[11px] text-blue-600 hover:underline"
            >
              Amazon ↗
            </a>
          )}
        </div>
      </div>
      <div className="relative aspect-square w-1/3 min-w-[120px] shrink-0 overflow-hidden rounded-md bg-neutral-50">
        {item.thumbnail_path ? (
          <Image
            src={item.thumbnail_path}
            alt={item.name}
            fill
            sizes="160px"
            className="object-contain"
            unoptimized
          />
        ) : (
          <div className="flex h-full w-full items-center justify-center text-[10px] text-neutral-400">
            no image
          </div>
        )}
      </div>
    </div>
  );
}

function buildSubtitle(item: CatalogItem): string {
  const parts: string[] = [];
  const descriptor = item.material[0] ?? (item.color !== 'unspecified' ? item.color : undefined);
  if (descriptor) parts.push(descriptor);
  const { w, d, h } = item.dimensions;
  parts.push(`${w} × ${d} × ${h} m`);
  return parts.join(' · ');
}

// ------------------------------- Prompt ------------------------------

function PromptTab({
  ctx,
  draft,
  setDraft,
}: {
  ctx: AgentContext | null;
  draft: string;
  setDraft: (v: string) => void;
}) {
  if (!ctx) return <div className="p-4 text-xs text-neutral-500">loading…</div>;
  const overridden = draft !== ctx.defaultRolePrompt;
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-xs">
      <section>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-semibold uppercase tracking-wider text-neutral-700">Block 1: Role + principles (editable)</h3>
          {overridden && (
            <button
              onClick={() => setDraft(ctx.defaultRolePrompt)}
              className="rounded bg-neutral-900 px-2 py-0.5 text-[10px] text-white"
            >
              reset
            </button>
          )}
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={14}
          className="w-full rounded border border-neutral-300 bg-white p-2 font-mono text-[11px] focus:border-neutral-500 focus:outline-none"
        />
        <div className="mt-1 text-[10px] text-neutral-500">
          ~{Math.ceil(draft.length / 4)} tokens · sent on next chat turn
        </div>
      </section>

      <section>
        <h3 className="mb-1 font-semibold uppercase tracking-wider text-neutral-700">Block 2: Room data (auto-generated)</h3>
        <details open>
          <summary className="cursor-pointer text-[10px] text-neutral-600">
            schema doc · ~{ctx.tokenEstimates.schemaDoc} tok
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 font-mono text-[10px] text-neutral-700">
            {ctx.schemaDoc}
          </pre>
        </details>
        <details>
          <summary className="mt-1 cursor-pointer text-[10px] text-neutral-600">
            NL summary · ~{ctx.tokenEstimates.summary} tok
          </summary>
          <pre className="mt-1 max-h-40 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-2 font-mono text-[10px] text-neutral-700">
            {ctx.summary}
          </pre>
        </details>
        <details>
          <summary className="mt-1 cursor-pointer text-[10px] text-neutral-600">
            compact JSON · ~{ctx.tokenEstimates.json} tok
          </summary>
          <pre className="mt-1 max-h-60 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-50 p-2 font-mono text-[10px] text-neutral-700">
            {ctx.compactRoomJson}
          </pre>
        </details>
      </section>

      <div className="border-t border-neutral-200 pt-2 text-[11px] text-neutral-700">
        Total: ~
        {Math.ceil(draft.length / 4) +
          ctx.tokenEstimates.json +
          ctx.tokenEstimates.summary +
          ctx.tokenEstimates.schemaDoc}{' '}
        tokens (cached after first turn)
      </div>
    </div>
  );
}

// ------------------------------- Debug -------------------------------

function DebugTab({ ctx }: { ctx: AgentContext | null }) {
  const [healthStatus, setHealthStatus] = useState<string | null>(null);
  const [checking, setChecking] = useState(false);

  async function checkHealth() {
    setChecking(true);
    const results: string[] = [];

    // 1. Check agent-context endpoint
    try {
      const t0 = Date.now();
      const r = await fetch('/api/agent-context', { cache: 'no-store' });
      const dt = Date.now() - t0;
      if (r.ok) {
        const data = await r.json();
        results.push(`✅ /api/agent-context → ${r.status} (${dt}ms) — ${data.catalog?.length ?? '?'} catalog items, ${data.placements?.length ?? 0} placements`);
      } else {
        const text = await r.text().catch(() => '');
        results.push(`❌ /api/agent-context → ${r.status}: ${text.slice(0, 200)}`);
      }
    } catch (e) {
      results.push(`❌ /api/agent-context → ${e instanceof Error ? e.message : String(e)}`);
    }

    // 2. Check chat endpoint with empty body (should return 400)
    try {
      const t0 = Date.now();
      const r = await fetch('/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
      const dt = Date.now() - t0;
      if (r.status === 400) {
        results.push(`✅ /api/chat → 400 (expected for empty msg) (${dt}ms)`);
      } else {
        const text = await r.text().catch(() => '');
        results.push(`⚠️ /api/chat → ${r.status} (${dt}ms): ${text.slice(0, 200)}`);
      }
    } catch (e) {
      results.push(`❌ /api/chat → ${e instanceof Error ? e.message : String(e)}`);
    }

    // 3. Quick smoke-test: send a tiny prompt and see if we get any SSE frames
    try {
      results.push('🔄 Smoke test: sending "list placements" to /api/chat…');
      const t0 = Date.now();
      const r = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: 'List current placements. Reply briefly.' }),
      });
      const dt = Date.now() - t0;
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        results.push(`❌ Smoke test HTTP ${r.status} (${dt}ms): ${text.slice(0, 300)}`);
      } else if (!r.body) {
        results.push(`❌ Smoke test: no response body (${dt}ms)`);
      } else {
        const reader = r.body.getReader();
        const decoder = new TextDecoder();
        let buf = '';
        let frames = 0;
        const types: string[] = [];
        const deadline = Date.now() + 30000; // 30s timeout
        while (Date.now() < deadline) {
          const { done, value } = await reader.read();
          if (done) break;
          buf += decoder.decode(value, { stream: true });
          let idx;
          while ((idx = buf.indexOf('\n\n')) !== -1) {
            const frame = buf.slice(0, idx);
            buf = buf.slice(idx + 2);
            const dl = frame.split('\n').find((l) => l.startsWith('data: '));
            if (dl) {
              try {
                const p = JSON.parse(dl.slice(6)) as { type: string };
                frames++;
                types.push(p.type);
              } catch { /* skip */ }
            }
          }
        }
        const elapsed = Date.now() - t0;
        if (frames > 0) {
          results.push(`✅ Smoke test OK: ${frames} SSE frames in ${elapsed}ms — types: ${types.join(', ')}`);
        } else {
          results.push(`❌ Smoke test: 0 SSE frames received in ${elapsed}ms — check terminal for server errors`);
        }
      }
    } catch (e) {
      results.push(`❌ Smoke test threw: ${e instanceof Error ? e.message : String(e)}`);
    }

    setHealthStatus(results.join('\n'));
    setChecking(false);
  }

  if (!ctx) return <div className="p-4 text-xs text-neutral-500">loading…</div>;
  const stats = [
    ['walls', ctx.compactRoom.walls.length],
    ['doors', ctx.compactRoom.doors?.length ?? 0],
    ['windows', ctx.compactRoom.windows?.length ?? 0],
    ['openings', ctx.compactRoom.openings?.length ?? 0],
    ['detected objects', ctx.compactRoom.objects?.length ?? 0],
    ['regions', ctx.compactRoom.regions?.length ?? 0],
    ['floor corners', ctx.compactRoom.floor.length],
    ['active placements', ctx.placements.length],
  ];
  return (
    <div className="flex h-full flex-col gap-3 overflow-y-auto p-3 text-xs">
      {/* Connectivity check */}
      <section>
        <div className="mb-1 flex items-center justify-between">
          <h3 className="font-semibold uppercase tracking-wider text-neutral-700">API Health Check</h3>
          <button
            onClick={checkHealth}
            disabled={checking}
            className="rounded bg-neutral-900 px-3 py-1 text-[10px] font-medium text-white disabled:opacity-40"
          >
            {checking ? 'checking…' : 'Run Check'}
          </button>
        </div>
        {healthStatus ? (
          <pre className="max-h-60 overflow-auto whitespace-pre-wrap rounded border border-neutral-200 bg-neutral-50 p-2 font-mono text-[10px] text-neutral-800">
            {healthStatus}
          </pre>
        ) : (
          <div className="rounded border border-dashed border-neutral-300 p-2 text-center text-[10px] text-neutral-500">
            Click &ldquo;Run Check&rdquo; to test API connectivity, Composio tools, and Anthropic
          </div>
        )}
      </section>

      <section>
        <h3 className="mb-1 font-semibold uppercase tracking-wider text-neutral-700">Room shape</h3>
        <div className="rounded border border-neutral-200 bg-white p-2 font-mono text-[11px]">
          {ctx.compactRoom.dim[0]} × {ctx.compactRoom.dim[1]} × {ctx.compactRoom.dim[2]} m
        </div>
        <div className="mt-2 grid grid-cols-2 gap-1">
          {stats.map(([k, v]) => (
            <div key={k as string} className="flex justify-between rounded bg-neutral-50 px-2 py-1 text-[11px]">
              <span className="text-neutral-600">{k}</span>
              <span className="font-mono text-neutral-900">{v}</span>
            </div>
          ))}
        </div>
      </section>

      <section>
        <h3 className="mb-1 font-semibold uppercase tracking-wider text-neutral-700">Token budget</h3>
        <div className="space-y-0.5 font-mono text-[11px]">
          <div className="flex justify-between"><span>role prompt</span><span>~{ctx.tokenEstimates.rolePrompt}</span></div>
          <div className="flex justify-between"><span>schema doc</span><span>~{ctx.tokenEstimates.schemaDoc}</span></div>
          <div className="flex justify-between"><span>NL summary</span><span>~{ctx.tokenEstimates.summary}</span></div>
          <div className="flex justify-between"><span>compact JSON</span><span>~{ctx.tokenEstimates.json}</span></div>
          <div className="mt-1 flex justify-between border-t border-neutral-200 pt-1 font-semibold">
            <span>total cached</span>
            <span>
              ~
              {ctx.tokenEstimates.rolePrompt +
                ctx.tokenEstimates.schemaDoc +
                ctx.tokenEstimates.summary +
                ctx.tokenEstimates.json}
            </span>
          </div>
        </div>
      </section>

      <section>
        <h3 className="mb-1 font-semibold uppercase tracking-wider text-neutral-700">NL summary</h3>
        <pre className="whitespace-pre-wrap rounded bg-neutral-50 p-2 font-mono text-[10px]">{ctx.summary}</pre>
      </section>

      <section>
        <h3 className="mb-1 font-semibold uppercase tracking-wider text-neutral-700">Active placements</h3>
        {ctx.placements.length === 0 ? (
          <div className="rounded border border-dashed border-neutral-300 p-3 text-center text-[11px] text-neutral-500">
            none yet — agent hasn&apos;t placed anything
          </div>
        ) : (
          <div className="space-y-1">
            {ctx.placements.map((p) => (
              <div key={p.id} className="rounded border border-neutral-200 bg-white p-2 font-mono text-[10px]">
                <div className="font-semibold">{p.id}</div>
                <div className="text-neutral-700">{p.catalog_item_id}</div>
                <div>
                  ({p.position.x}, {p.position.z}) yaw={p.rotation_y.toFixed(2)}
                </div>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="text-[10px] text-neutral-400">
        Tip: open browser DevTools console for client-side logs, and watch the terminal running <code>npm run dev</code> for server-side logs.
      </section>
    </div>
  );
}
