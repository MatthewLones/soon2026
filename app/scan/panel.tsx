'use client';

import { useEffect, useRef, useState } from 'react';
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
        </div>
        <button
          onClick={async () => {
            if (!ctx?.placements.length) return;
            await fetch('/api/placements', { method: 'DELETE' });
            onRefresh();
          }}
          disabled={!ctx?.placements.length}
          className="rounded bg-red-600 px-2 py-0.5 text-[10px] font-medium text-white transition hover:bg-red-700 disabled:bg-neutral-200 disabled:text-neutral-400"
        >
          reset placements
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
      const res = await fetch('/api/chat', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          message: input,
          rolePromptOverride,
          model,
          thinkingBudget: thinkingOn ? thinkingBudget : 0,
        }),
      });
      if (!res.ok || !res.body) {
        const text = await res.text().catch(() => '');
        setEvents((e) => [...e, { type: 'error', message: text || `HTTP ${res.status}` }]);
        return;
      }
      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
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
            setEvents((e) => [...e, parsed]);
          } catch (err) {
            console.error('bad SSE frame', frame, err);
          }
        }
      }
    } catch (e) {
      setEvents((evts) => [
        ...evts,
        { type: 'error', message: e instanceof Error ? e.message : String(e) },
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

function CatalogTab({
  catalog,
  onDragStart,
  onDragEnd,
}: {
  catalog: CatalogItem[];
  onDragStart?: (id: string) => void;
  onDragEnd?: () => void;
}) {
  const [filter, setFilter] = useState('');
  const filtered = catalog.filter((item) => {
    if (!filter) return true;
    const hay = `${item.name} ${item.brand} ${item.category} ${item.style_tags.join(' ')}`.toLowerCase();
    return hay.includes(filter.toLowerCase());
  });
  return (
    <div className="flex h-full flex-col">
      <div className="border-b border-neutral-200 bg-neutral-50/60 p-2">
        <input
          type="text"
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filter by name, brand, category, tag…"
          className="w-full rounded border border-neutral-300 bg-white px-2 py-1 text-xs focus:border-neutral-500 focus:outline-none"
        />
        <div className="mt-1 text-[10px] text-neutral-500">
          {filtered.length} / {catalog.length} items · drag a card into the room
        </div>
      </div>
      <div className="min-h-0 flex-1 space-y-2 overflow-y-auto p-3 text-xs">
        {filtered.map((item) => (
          <div
            key={item.id}
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData('application/x-catalog-item', item.id);
              e.dataTransfer.effectAllowed = 'copy';
              onDragStart?.(item.id);
            }}
            onDragEnd={() => onDragEnd?.()}
            className="cursor-grab select-none rounded border border-neutral-200 bg-white p-2 active:cursor-grabbing hover:border-neutral-400"
          >
            <div className="flex items-start justify-between">
              <div>
                <div className="font-medium text-neutral-900">{item.name}</div>
                <div className="text-[10px] text-neutral-500">
                  {item.brand} · {item.category} · {item.color}
                </div>
              </div>
              <div className="text-right">
                <div className="font-mono text-[11px]">${item.price_usd ?? '—'}</div>
                <div className="text-[10px] text-neutral-500">
                  {item.dimensions.w}×{item.dimensions.d}×{item.dimensions.h}m
                </div>
              </div>
            </div>
            <div className="mt-1 flex flex-wrap gap-1">
              {item.style_tags.map((t) => (
                <span
                  key={t}
                  className="rounded bg-neutral-100 px-1.5 py-0.5 text-[10px] text-neutral-600"
                >
                  {t}
                </span>
              ))}
            </div>
            <div className="mt-1 text-[11px] text-neutral-700">{item.description}</div>
            <div className="mt-1 flex items-center justify-between text-[10px]">
              <span className="font-mono text-neutral-400">{item.id}</span>
              {item.asin && (
                <a
                  href={`https://www.amazon.com/dp/${item.asin}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="text-blue-600 hover:underline"
                >
                  amazon ↗
                </a>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
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
    </div>
  );
}
