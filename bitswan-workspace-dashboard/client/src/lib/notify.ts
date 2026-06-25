// Unified notifications store — the single surface for transient feedback.
//
// We used to render two separate things: a bottom-right sonner toast stack AND
// a bottom-left git-task-queue panel. That split the operator's attention. This
// module replaces sonner as the toast ENGINE: every `toast.*` call feeds an
// in-memory store that the queue/activity panel renders alongside the git
// tasks, so all activity shows up in ONE place. The exported `toast` keeps
// sonner's API shape (success/error/info/loading/promise/dismiss, `id`-based
// updates, `description`, `action`) so the call sites need only swap the import.
//
// These notifications are a FULL session history of what was done — they do NOT
// auto-expire (a `loading` item is updated in place to its terminal state by
// id). The panel shows them oldest→newest; the git tasks alongside them keep
// their own server-side history.

import { useSyncExternalStore } from 'react';

export type NotifyStatus = 'loading' | 'success' | 'error' | 'info' | 'message';

export interface Notification {
  id: string;
  status: NotifyStatus;
  message: string;
  description?: string;
  action?: { label: string; onClick: () => void };
  /** epoch ms — when first created (stable ordering key). */
  created_at: number;
  /** epoch ms — last updated (loading→terminal transitions). */
  updated_at: number;
  /**
   * Every distinct message this notification has shown, oldest→newest. A
   * long-running op (deploy/promote) updates a single notification's message
   * through many progress lines; instead of those replacing each other and
   * being lost, we keep them all here so the row can be "unrolled" to show the
   * full trail. `message` is always the latest (== the last trail entry).
   */
  trail: { text: string; at: number }[];
}

interface ToastOptions {
  id?: string | number;
  /** Accepted for sonner-API compatibility; ignored — history never expires. */
  duration?: number;
  description?: string;
  action?: { label: string; onClick: () => void };
}

type Msg = string | number;

let items: Notification[] = [];
const listeners = new Set<() => void>();
let seq = 0;

function emit(): void {
  // Full, uncapped session history — the activity log never drops entries, so
  // the panel's scrollback is effectively infinite (bounded only by the
  // session). `items` is stored newest-first internally; the panel reverses it.
  for (const l of listeners) l();
}

function remove(id: string): void {
  const before = items.length;
  items = items.filter((n) => n.id !== id);
  if (items.length !== before) emit();
}

function upsert(status: NotifyStatus, message: Msg, opts?: ToastOptions): string {
  const id = opts?.id != null ? String(opts.id) : `n${++seq}`;
  const now = Date.now();
  const existing = items.find((n) => n.id === id);
  const msg = String(message ?? '');
  // Append to the trail when the message actually changed, so an updating
  // notification keeps the full history of what it reported (never loses a
  // progress line) without recording duplicate ticks.
  const prevTrail = existing?.trail ?? [];
  const lastText = prevTrail.length ? prevTrail[prevTrail.length - 1]!.text : undefined;
  const trail =
    msg && msg !== lastText ? [...prevTrail, { text: msg, at: now }] : prevTrail;
  const next: Notification = {
    id,
    status,
    message: msg,
    description: opts?.description ?? existing?.description,
    action: opts?.action ?? existing?.action,
    created_at: existing?.created_at ?? now,
    updated_at: now,
    trail,
  };
  // Replace any prior entry with the same id (loading → success/error updates),
  // keeping the rest in place. Newest-first internally.
  items = [next, ...items.filter((n) => n.id !== id)];
  emit();
  return id;
}

function resolveMsg<T>(m: Msg | ((data: T) => Msg) | undefined, data: T): Msg | undefined {
  if (typeof m === 'function') return (m as (d: T) => Msg)(data);
  return m;
}

interface PromiseMessages<T> {
  loading: Msg;
  success?: Msg | ((data: T) => Msg);
  error?: Msg | ((err: unknown) => Msg);
}

type ToastFn = ((message: Msg, opts?: ToastOptions) => string) & {
  success: (message: Msg, opts?: ToastOptions) => string;
  error: (message: Msg, opts?: ToastOptions) => string;
  info: (message: Msg, opts?: ToastOptions) => string;
  warning: (message: Msg, opts?: ToastOptions) => string;
  message: (message: Msg, opts?: ToastOptions) => string;
  loading: (message: Msg, opts?: ToastOptions) => string;
  dismiss: (id?: string | number) => void;
  promise: <T>(
    promise: Promise<T>,
    msgs: PromiseMessages<T>,
    opts?: ToastOptions,
  ) => string;
};

const base = ((message: Msg, opts?: ToastOptions) =>
  upsert('message', message, opts)) as ToastFn;

base.success = (message, opts) => upsert('success', message, opts);
base.error = (message, opts) => upsert('error', message, opts);
base.info = (message, opts) => upsert('info', message, opts);
// sonner distinguishes warning visually; we fold it into the error-ish lane.
base.warning = (message, opts) => upsert('error', message, opts);
base.message = (message, opts) => upsert('message', message, opts);
base.loading = (message, opts) => upsert('loading', message, opts);

base.dismiss = (id) => {
  if (id == null) {
    if (items.length) {
      items = [];
      emit();
    }
    return;
  }
  remove(String(id));
};

base.promise = (promise, msgs, opts) => {
  const id = upsert('loading', msgs.loading, opts);
  promise.then(
    (data) => {
      const m = resolveMsg(msgs.success, data);
      if (m !== undefined) upsert('success', m, { id });
      else remove(id);
    },
    (err) => {
      const m = resolveMsg(msgs.error, err);
      if (m !== undefined) upsert('error', m, { id });
      else remove(id);
    },
  );
  return id;
};

export const toast = base;

// ── React binding ──────────────────────────────────────────────────────────
function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
function getSnapshot(): Notification[] {
  return items;
}

/** Live list of session notifications (newest-first; the panel reverses). */
export function useNotifications(): Notification[] {
  return useSyncExternalStore(subscribe, getSnapshot, getSnapshot);
}
