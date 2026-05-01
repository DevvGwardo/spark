export type ToastType = 'info' | 'success' | 'warning' | 'error';

export interface ToastItem {
  id: string;
  message: string;
  type: ToastType;
  duration: number;
}

export interface ToastOptions {
  type?: ToastType;
  duration?: number;
}

type ToastListener = (toasts: ToastItem[]) => void;

const listeners = new Set<ToastListener>();
const toasts: ToastItem[] = [];
let idCounter = 0;

function generateId(): string {
  return `toast-${++idCounter}-${Date.now()}`;
}

function notify(): void {
  listeners.forEach((listener) => listener([...toasts]));
}

export function toast(message: string, opts: ToastOptions = {}): string {
  const { type = 'info', duration = 5000 } = opts;
  const id = generateId();

  toasts.unshift({ id, message, type, duration });
  if (toasts.length > 5) {
    toasts.pop();
  }

  notify();

  if (duration > 0) {
    setTimeout(() => {
      dismiss(id);
    }, duration);
  }

  return id;
}

export function dismiss(id: string): void {
  const index = toasts.findIndex((t) => t.id === id);
  if (index > -1) {
    toasts.splice(index, 1);
    notify();
  }
}

export function clear(): void {
  toasts.length = 0;
  notify();
}

export function subscribe(listener: ToastListener): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

export function getToasts(): ToastItem[] {
  return [...toasts];
}

toast.info = (message: string, duration?: number) => toast(message, { type: 'info', duration });
toast.success = (message: string, duration?: number) => toast(message, { type: 'success', duration });
toast.warning = (message: string, duration?: number) => toast(message, { type: 'warning', duration });
toast.error = (message: string, duration?: number) => toast(message, { type: 'error', duration });
toast.dismiss = dismiss;
toast.clear = clear;