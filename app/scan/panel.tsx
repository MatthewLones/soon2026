'use client';

import { useEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import Image from 'next/image';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import type { CatalogItem } from '@/lib/agent/catalog';
import type { Placement } from '@/lib/room/grid';
import type {
  SemanticRoom,
  WallNode,
  ObjectNode,
} from '@/lib/room/semantic_tree';
import type { AgentContext } from './scan-layout';

type Tab = 'chat' | 'catalog' | 'cart' | 'prompt';

const TAB_LABEL: Record<Tab, string> = {
  chat: 'chat',
  catalog: 'catalog',
  cart: 'cart',
  prompt: 'system prompt',
};

export type ChatEvent =
  | { type: 'user_message'; text: string; t: number }
  | { type: 'tool_call'; id: string; name: string; input: unknown; t: number }
  | { type: 'tool_result'; id: string; result: unknown; t: number }
  | { type: 'thinking'; text: string; t: number }
  | { type: 'assistant_message'; text: string; t: number }
  | { type: 'loop_aborted'; reason: string; t: number }
  | { type: 'error'; message: string; t?: number };

/** Streaming-placement SSE events. Rendered in the 3D canvas (overlay), not
 *  in the chat transcript. The layout owns the overlay state and exposes a
 *  handler so ChatTab can forward these as they arrive. */
export type StreamEvent =
  | { type: 'placements_cleared'; t: number }
  | { type: 'placement_committed'; placement: Placement; index: number; t: number };

export type ModelChoice = 'sonnet' | 'opus';

/** Chat state held in the parent layout so toggling verbose mode (which
 *  swaps AgentPanel for TreeDebugPanel) doesn't blow away the user's
 *  draft, conversation history, or settings. */
export type ChatState = {
  input: string;
  events: ChatEvent[];
  streaming: boolean;
  model: ModelChoice;
  thinkingOn: boolean;
  thinkingBudget: number;
  maxToolIterations: number;
};

export const INITIAL_CHAT_STATE: ChatState = {
  input: '',
  events: [],
  streaming: false,
  model: 'sonnet',
  thinkingOn: false,
  thinkingBudget: 5000,
  maxToolIterations: 24,
};

export default function AgentPanel({
  ctx,
  onRefresh,
  onCatalogDragStart,
  onCatalogDragEnd,
  chatState,
  setChatState,
  rolePromptDraft,
  setRolePromptDraft,
  selectedCatalogItemId,
  onSelectCatalogItem,
  onStreamEvent,
}: {
  ctx: AgentContext | null;
  onRefresh: () => void;
  onCatalogDragStart?: (id: string) => void;
  onCatalogDragEnd?: () => void;
  chatState: ChatState;
  setChatState: Dispatch<SetStateAction<ChatState>>;
  rolePromptDraft: string;
  setRolePromptDraft: (v: string) => void;
  selectedCatalogItemId: string | null;
  onSelectCatalogItem: (id: string | null) => void;
  onStreamEvent?: (ev: StreamEvent) => void;
}) {
  const [tab, setTab] = useState<Tab>('chat');

  // Seed the role-prompt textarea once we have context.
  useEffect(() => {
    if (ctx && !rolePromptDraft) setRolePromptDraft(ctx.defaultRolePrompt);
  }, [ctx, rolePromptDraft, setRolePromptDraft]);

  return (
    <aside className="flex w-[440px] shrink-0 flex-col border-l border-neutral-300 bg-white text-neutral-900">
      <div className="flex border-b border-neutral-200 bg-neutral-50/80">
        {(['chat', 'cart', 'catalog', 'prompt'] as Tab[]).map((t) => (
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
            {TAB_LABEL[t]}
          </button>
        ))}
      </div>

      <div className="min-h-0 flex-1">
        {tab === 'chat' && (
          <ChatTab
            rolePromptOverride={rolePromptDraft !== ctx?.defaultRolePrompt ? rolePromptDraft : undefined}
            onTurnComplete={onRefresh}
            chatState={chatState}
            setChatState={setChatState}
            onStreamEvent={onStreamEvent}
          />
        )}
        {tab === 'catalog' && (
          <CatalogTab
            catalog={ctx?.catalog ?? []}
            onDragStart={onCatalogDragStart}
            onDragEnd={onCatalogDragEnd}
          />
        )}
        {tab === 'cart' && (
          <CartTab
            placements={ctx?.placements ?? []}
            catalog={ctx?.catalog ?? []}
            selectedCatalogItemId={selectedCatalogItemId}
            onSelect={onSelectCatalogItem}
          />
        )}
        {tab === 'prompt' && (
          <PromptTab ctx={ctx} draft={rolePromptDraft} setDraft={setRolePromptDraft} />
        )}
      </div>
    </aside>
  );
}

// ------------------------------- Chat -------------------------------

function ChatTab({
  rolePromptOverride,
  onTurnComplete,
  chatState,
  setChatState,
  onStreamEvent,
}: {
  rolePromptOverride?: string;
  onTurnComplete: () => void;
  chatState: ChatState;
  setChatState: Dispatch<SetStateAction<ChatState>>;
  onStreamEvent?: (ev: StreamEvent) => void;
}) {
  const { input, events, streaming, model, thinkingOn, thinkingBudget, maxToolIterations } =
    chatState;
  const scrollerRef = useRef<HTMLDivElement>(null);

  // Functional updates so streaming writes from a stale closure (e.g. when
  // the panel was unmounted mid-stream by a verbose toggle) still merge
  // correctly against the latest state.
  const pushEvent = (ev: ChatEvent) =>
    setChatState((s) => ({ ...s, events: [...s.events, ev] }));

  useEffect(() => {
    const el = scrollerRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [events]);

  async function send() {
    if (!input.trim() || streaming) return;
    const message = input;
    setChatState((s) => ({
      ...s,
      input: '',
      events: [{ type: 'user_message', text: message, t: Date.now() }],
      streaming: true,
    }));
    try {
      console.log('[ChatTab] Sending to /api/chat…', message.slice(0, 80));
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message,
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
        pushEvent({ type: 'error', message: `HTTP ${res.status}: ${text || res.statusText}` });
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
            const parsed = JSON.parse(dataLine.slice(6)) as ChatEvent | StreamEvent;
            frameCount++;
            console.log('[ChatTab] SSE frame', frameCount, '→', parsed.type, 'name' in parsed ? (parsed as { name: string }).name : '');
            // Streaming-placement events feed the 3D canvas overlay, not the
            // chat transcript. Everything else is a chat-relevant event.
            if (parsed.type === 'placements_cleared' || parsed.type === 'placement_committed') {
              onStreamEvent?.(parsed);
            } else {
              pushEvent(parsed);
            }
          } catch (err) {
            console.error('[ChatTab] bad SSE frame', frame, err);
            pushEvent({ type: 'error', message: `Bad SSE frame: ${frame.slice(0, 200)}` });
          }
        }
      }
      if (frameCount === 0) {
        console.warn('[ChatTab] Stream ended with 0 SSE frames \u2014 the agent may have failed silently');
        pushEvent({ type: 'error', message: 'Stream ended with no events \u2014 check the terminal for server-side errors' });
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error('[ChatTab] fetch threw:', msg);
      pushEvent({ type: 'error', message: msg });
    } finally {
      setChatState((s) => ({ ...s, streaming: false }));
      onTurnComplete();
    }
  }

  return (
    <div className="flex h-full flex-col p-3">
      <div className="flex h-full min-h-0 flex-col overflow-hidden rounded border border-dashed border-neutral-300">
      <div
        ref={scrollerRef}
        className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-xs"
      >
        {events.map((e, i) => (
          <EventCard key={i} event={e} />
        ))}
        {streaming && <div className="animate-pulse text-neutral-500">streaming…</div>}
      </div>
      <div className="border-t border-dashed border-neutral-300 p-2">
        <textarea
          value={input}
          onChange={(e) => setChatState((s) => ({ ...s, input: e.target.value }))}
          onKeyDown={(e) => {
            // Enter sends, Shift+Enter inserts a newline. Ignore while
            // streaming so a stray Enter can't trigger a second turn.
            if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
              e.preventDefault();
              if (!streaming) void send();
            }
          }}
          rows={3}
          className="w-full resize-none rounded bg-transparent p-2 text-xs outline-none placeholder:text-neutral-400"
          placeholder="What would you like the agent to do?"
          disabled={streaming}
        />
        <div className="mt-2 flex items-center justify-between gap-2">
          <div className="flex items-center gap-2 text-[10px]">
            <select
              value={model}
              onChange={(e) =>
                setChatState((s) => ({ ...s, model: e.target.value as ModelChoice }))
              }
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
                onChange={(e) =>
                  setChatState((s) => ({ ...s, thinkingOn: e.target.checked }))
                }
                disabled={streaming}
                className="h-3 w-3"
              />
              think
            </label>
            {thinkingOn && (
              <input
                type="number"
                value={thinkingBudget}
                onChange={(e) =>
                  setChatState((s) => ({
                    ...s,
                    thinkingBudget: Math.max(1024, Number(e.target.value) || 5000),
                  }))
                }
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
                  setChatState((s) => ({
                    ...s,
                    maxToolIterations: Math.min(
                      64,
                      Math.max(4, Number(e.target.value) || 24)
                    ),
                  }))
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
  if (event.type === 'user_message') {
    return (
      <div className="flex justify-end">
        <div className="max-w-[85%] rounded-2xl rounded-br-sm bg-neutral-900 px-3 py-1.5 text-xs text-white">
          <div className="whitespace-pre-wrap">{event.text}</div>
        </div>
      </div>
    );
  }
  if (event.type === 'assistant_message') {
    return (
      <div className="flex justify-start">
        <div className="max-w-[85%] rounded-2xl rounded-bl-sm border border-neutral-300 bg-white px-3 py-2 text-xs text-neutral-900">
          <div className="markdown-message">
            <ReactMarkdown remarkPlugins={[remarkGfm]}>{event.text}</ReactMarkdown>
          </div>
        </div>
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

// -------------------------------- Cart -------------------------------

/**
 * Selection-synced cart, grouped by catalog item. Four chairs of the same
 * product collapse into one "4× Chair" row. Selection is at the catalog
 * level: clicking a row highlights every instance of that product in 3D,
 * and clicking any instance in 3D highlights the matching row here.
 *
 * Footer totals known prices (qty × unit) — items without `price_usd`
 * (vendor uploads, marketplace imports without scraped pricing) are
 * flagged but excluded from the sum.
 */
type CartGroup = {
  catalogItemId: string;
  item: CatalogItem | null;
  qty: number;
  manualCount: number;
};

function CartTab({
  placements,
  catalog,
  selectedCatalogItemId,
  onSelect,
}: {
  placements: Placement[];
  catalog: CatalogItem[];
  selectedCatalogItemId: string | null;
  onSelect: (id: string | null) => void;
}) {
  const rowRefs = useRef(new Map<string, HTMLDivElement | null>());

  // Group placements by catalog_item_id. Insertion order = first-seen
  // order in the placements array, which is stable across solves.
  const groups = useMemo<CartGroup[]>(() => {
    const map = new Map<string, CartGroup>();
    for (const p of placements) {
      const cid = p.catalog_item_id;
      let g = map.get(cid);
      if (!g) {
        g = {
          catalogItemId: cid,
          item: catalog.find((c) => c.id === cid) ?? null,
          qty: 0,
          manualCount: 0,
        };
        map.set(cid, g);
      }
      g.qty += 1;
      if (p.source === 'drag') g.manualCount += 1;
    }
    return Array.from(map.values());
  }, [placements, catalog]);

  // When selection changes from outside (3D click), scroll the matching
  // group row into view.
  useEffect(() => {
    if (!selectedCatalogItemId) return;
    const el = rowRefs.current.get(selectedCatalogItemId);
    if (el) el.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  }, [selectedCatalogItemId]);

  const knownPriceTotal = groups.reduce(
    (acc, g) => acc + (g.item?.price_usd ?? 0) * g.qty,
    0
  );
  const unpricedGroups = groups.filter((g) => g.item?.price_usd === undefined).length;
  const totalQty = groups.reduce((acc, g) => acc + g.qty, 0);

  if (placements.length === 0) {
    return (
      <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center text-xs text-neutral-500">
        <div className="text-sm font-medium text-neutral-700">Cart is empty</div>
        <div>Items the agent places — or that you drag in from the catalog — will show up here.</div>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col">
      <div className="min-h-0 flex-1 space-y-1.5 overflow-y-auto p-3">
        {groups.map(({ catalogItemId, item, qty, manualCount }) => {
          const isSelected = selectedCatalogItemId === catalogItemId;
          const name = item?.name ?? catalogItemId;
          const subtitle = item ? `${item.brand} · ${prettyCategory(item.category)}` : 'unknown item';
          const unitPrice = item?.price_usd;
          const lineTotal = unitPrice !== undefined ? unitPrice * qty : undefined;
          const priceLabel = lineTotal !== undefined ? `$${lineTotal.toFixed(2)}` : '—';
          const unitLabel =
            qty > 1 && unitPrice !== undefined ? `$${unitPrice.toFixed(2)} ea` : null;
          // ABO items live on Amazon — give the user a one-click path to buy.
          // Vendor uploads / marketplace items don't have a public URL yet, so
          // the link only renders for source=='abo' with an asin.
          const buyUrl =
            item?.asin && item.source === 'abo'
              ? `https://www.amazon.com/dp/${item.asin}`
              : null;
          // Row uses div+role=button (not <button>) because we nest an <a> for
          // the buy link, and <a> inside <button> is invalid HTML.
          return (
            <div
              key={catalogItemId}
              ref={(el) => {
                rowRefs.current.set(catalogItemId, el);
              }}
              role="button"
              tabIndex={0}
              onClick={() => onSelect(isSelected ? null : catalogItemId)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') {
                  e.preventDefault();
                  onSelect(isSelected ? null : catalogItemId);
                }
              }}
              className={
                'flex w-full cursor-pointer items-center gap-3 rounded-md border p-2 text-left transition ' +
                (isSelected
                  ? 'border-purple-500 bg-purple-50 ring-2 ring-purple-300'
                  : 'border-neutral-200 bg-white hover:bg-neutral-50')
              }
            >
              <div className="relative h-12 w-12 shrink-0 overflow-hidden rounded bg-neutral-100">
                {item?.thumbnail_path ? (
                  <Image
                    src={item.thumbnail_path}
                    alt={name}
                    fill
                    sizes="48px"
                    className="object-contain"
                    unoptimized
                  />
                ) : (
                  <div className="flex h-full w-full items-center justify-center text-[9px] text-neutral-400">
                    no img
                  </div>
                )}
                {qty > 1 && (
                  <div className="absolute right-0 top-0 rounded-bl bg-neutral-900/85 px-1 py-0.5 text-[9px] font-bold leading-none text-white">
                    {qty}×
                  </div>
                )}
              </div>
              <div className="min-w-0 flex-1">
                <div className="truncate text-[12px] font-medium text-neutral-900">
                  {qty > 1 && <span className="text-neutral-500">{qty}× </span>}
                  {name}
                </div>
                <div className="truncate text-[10px] text-neutral-500">{subtitle}</div>
                {buyUrl && (
                  <a
                    href={buyUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                    onClick={(e) => e.stopPropagation()}
                    className="mt-0.5 inline-block text-[10px] text-blue-600 hover:underline"
                  >
                    Buy on Amazon ↗
                  </a>
                )}
              </div>
              <div className="shrink-0 text-right">
                <div className="text-[12px] font-semibold text-neutral-900">{priceLabel}</div>
                {unitLabel && (
                  <div className="text-[9px] text-neutral-500">{unitLabel}</div>
                )}
                {manualCount > 0 && (
                  <div className="text-[9px] uppercase tracking-wider text-neutral-400">
                    {manualCount === qty ? 'manual' : `${manualCount} manual`}
                  </div>
                )}
              </div>
            </div>
          );
        })}
      </div>
      {/* Footer: thin meta line on top, large prominent total on the very
          bottom row so the dollar number is the last thing the eye lands on. */}
      <div className="border-t border-neutral-200 bg-white">
        <div className="flex items-center justify-between px-3 pt-2 text-[10px] text-neutral-500">
          <span>
            {totalQty} item{totalQty === 1 ? '' : 's'}
            {groups.length !== totalQty && ` · ${groups.length} unique`}
          </span>
          {unpricedGroups > 0 && (
            <span>
              {unpricedGroups} without listed price
            </span>
          )}
        </div>
        <div className="flex items-baseline justify-between border-t border-neutral-100 bg-neutral-50 px-3 py-3">
          <span className="text-xs font-semibold uppercase tracking-wider text-neutral-700">
            Total
          </span>
          <span className="text-lg font-bold text-neutral-900">
            ${knownPriceTotal.toFixed(2)}
          </span>
        </div>
      </div>
    </div>
  );
}

// --------------------------- System prompt ---------------------------

/**
 * Mirrors what the agent loop literally sends as the `system` array
 * (lib/agent/loop.ts buildSystemPrompt):
 *   Block 1 — editable role + principles (rolePrompt)
 *   Block 2 — `BUILDING SUMMARY: ...` from describeTreeShort(tree)
 *
 * The compact-room JSON / NL summary / schema doc that used to live here are
 * not sent anymore — the agent reads the semantic tree via LIST_ROOMS /
 * INSPECT_ROOM tools instead. So this tab now also exposes the tree schema
 * doc (so the user knows what shape the agent gets back from INSPECT_ROOM)
 * and a peek at the compact tree JSON for that same drill-down.
 */
function PromptTab({
  ctx,
  draft,
  setDraft,
}: {
  ctx: AgentContext | null;
  draft: string;
  setDraft: (v: string) => void;
}) {
  if (!ctx) return <div className="p-4 text-sm text-neutral-500">loading…</div>;
  const overridden = draft !== ctx.defaultRolePrompt;
  const draftTok = Math.ceil(draft.length / 4);
  const totalTok = draftTok + ctx.tokenEstimates.treeSummary;

  return (
    <div className="flex h-full flex-col gap-5 overflow-y-auto p-4 text-sm leading-relaxed text-neutral-800">
      <section>
        <div className="mb-2 flex items-center justify-between">
          <h3 className="text-[12px] font-semibold uppercase tracking-wider text-neutral-700">
            Block 1 · Role + principles
          </h3>
          {overridden && (
            <button
              onClick={() => setDraft(ctx.defaultRolePrompt)}
              className="rounded bg-neutral-900 px-2 py-0.5 text-[11px] text-white"
            >
              reset
            </button>
          )}
        </div>
        <textarea
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          rows={14}
          className="w-full rounded border border-neutral-300 bg-white p-3 font-mono text-[12px] leading-relaxed focus:border-neutral-500 focus:outline-none"
        />
        <div className="mt-1.5 text-xs text-neutral-500">
          ~{draftTok} tok · editable · sent on next chat turn
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-neutral-700">
          Block 2 · Building summary
        </h3>
        <div className="rounded border border-neutral-200 bg-neutral-50/70 p-3">
          <TreeNarrative tree={ctx.tree} />
        </div>
        <div className="mt-1.5 text-xs text-neutral-500">
          ~{ctx.tokenEstimates.treeSummary} tok · auto-generated every turn from the live semantic tree
        </div>
      </section>

      <section>
        <h3 className="mb-2 text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
          Tool reference (not in system prompt)
        </h3>
        <details>
          <summary className="cursor-pointer text-xs text-neutral-600 hover:text-neutral-900">
            tree schema · ~{ctx.tokenEstimates.treeSchemaDoc} tok
            <span className="ml-1 text-neutral-400">— shape returned by INSPECT_ROOM</span>
          </summary>
          <pre className="mt-2 max-h-72 overflow-auto whitespace-pre-wrap rounded bg-neutral-50 p-3 font-mono text-[11px] leading-relaxed text-neutral-700">
            {ctx.treeSchemaDoc}
          </pre>
        </details>
        <details className="mt-1">
          <summary className="cursor-pointer text-xs text-neutral-600 hover:text-neutral-900">
            raw tree JSON · ~{ctx.tokenEstimates.tree} tok
            <span className="ml-1 text-neutral-400">— what the agent sees on INSPECT</span>
          </summary>
          <pre className="mt-2 max-h-80 overflow-auto whitespace-pre-wrap break-all rounded bg-neutral-50 p-3 font-mono text-[11px] leading-relaxed text-neutral-700">
            {ctx.treeJson}
          </pre>
        </details>
      </section>

      <div className="border-t border-neutral-200 pt-3 text-sm text-neutral-700">
        System prompt total: <span className="font-semibold">~{totalTok} tok</span>{' '}
        <span className="text-xs text-neutral-500">(cached after first turn)</span>
      </div>
    </div>
  );
}

// ----------------------- Tree → narrative -----------------------

/**
 * Walks the live semantic tree and renders a human-readable narrative —
 * headings, sentences, bulleted lists. The agent's actual `treeSummary` is a
 * compact one-liner; this UI version unpacks the tree node-by-node so the
 * user can see what the room actually looks like without squinting at JSON.
 */
function TreeNarrative({ tree }: { tree: AgentContext['tree'] }) {
  const rooms = tree.building.rooms;
  if (rooms.length === 0) {
    return <p className="text-neutral-500">No rooms detected yet.</p>;
  }
  return (
    <div className="space-y-4 text-[13px] leading-relaxed text-neutral-800">
      <p>
        Building has <strong>{rooms.length} room{rooms.length === 1 ? '' : 's'}</strong>.
      </p>
      {rooms.map((room) => (
        <RoomNarrative key={room.id} room={room} />
      ))}
    </div>
  );
}

function RoomNarrative({ room }: { room: SemanticRoom }) {
  const placeable = room.walls.filter((w) => w.placeable).length;
  const wallLabels = room.walls.map((w) => w.label).join(', ');
  return (
    <article className="space-y-2 border-l-2 border-neutral-300 pl-3">
      <header className="flex items-baseline justify-between gap-2">
        <h4 className="text-[14px] font-semibold text-neutral-900">
          Room {room.number}
        </h4>
        <span className="text-xs text-neutral-500">
          {room.area_m2} m² · {room.bounds.max.x - room.bounds.min.x} × {room.bounds.max.z - room.bounds.min.z} m
        </span>
      </header>
      <p>
        Bordered by <strong>{room.walls.length}</strong> wall
        {room.walls.length === 1 ? '' : 's'} ({wallLabels || '—'}); {placeable} placeable.
        {room.door_ids.length > 0 && (
          <> {room.door_ids.length} door{room.door_ids.length === 1 ? '' : 's'}.</>
        )}
        {room.opening_ids.length > 0 && (
          <> {room.opening_ids.length} archway{room.opening_ids.length === 1 ? '' : 's'}.</>
        )}
      </p>

      {room.walls.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            walls
          </div>
          <ul className="space-y-1.5">
            {room.walls.map((w) => (
              <li key={w.id}>
                <WallSentence wall={w} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {room.objects.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            existing furniture (kept)
          </div>
          <ul className="space-y-1">
            {room.objects.map((o) => (
              <li key={o.id}>
                <ObjectSentence obj={o} />
              </li>
            ))}
          </ul>
        </div>
      )}

      {room.placements.length > 0 && (
        <div>
          <div className="mb-1 text-[11px] font-medium uppercase tracking-wider text-neutral-500">
            ai placements
          </div>
          <ul className="space-y-1">
            {room.placements.map((o) => (
              <li key={o.id}>
                <ObjectSentence obj={o} />
              </li>
            ))}
          </ul>
        </div>
      )}
    </article>
  );
}

function WallSentence({ wall }: { wall: WallNode }) {
  const longest = wall.free_spans.reduce((m, s) => Math.max(m, s.length_m), 0);
  return (
    <span>
      <strong className="font-mono text-neutral-900">{wall.label}</strong>{' '}
      <span className="text-neutral-700">
        — {wall.length_m} m, faces {wall.facing} (into room from {wall.inward}).{' '}
      </span>
      {wall.placeable ? (
        <span className="text-neutral-700">
          Longest free span <strong>{longest.toFixed(2)} m</strong>
          {wall.suggests.length > 0 && (
            <>
              {' '}· good for{' '}
              <span className="text-emerald-700">{wall.suggests.join(', ')}</span>
            </>
          )}
          .
        </span>
      ) : (
        <span className="italic text-neutral-500">Not placeable.</span>
      )}
      {wall.features.length > 0 && (
        <span className="text-amber-700">
          {' '}
          Features: {wall.features.map((f) => `${f.kind} (${f.width_m} m wide)`).join(', ')}.
        </span>
      )}
    </span>
  );
}

function ObjectSentence({ obj }: { obj: ObjectNode }) {
  const { w, d, h } = obj.dimensions;
  return (
    <span>
      <strong className="text-neutral-900">{obj.category}</strong>
      <span className="text-neutral-600">
        {' '}
        ({w}×{d}×{h} m)
        {obj.near_wall && (
          <>
            {' '}— near wall{' '}
            <span className="font-mono">{obj.near_wall}</span>
          </>
        )}
        . Free space: F={obj.free_space_around.front_m} B={obj.free_space_around.back_m} L={obj.free_space_around.left_m} R={obj.free_space_around.right_m} m.
      </span>
      {obj.suggests.length > 0 && (
        <span className="text-emerald-700">
          {' '}Pairs well with {obj.suggests.join(', ')}.
        </span>
      )}
    </span>
  );
}

