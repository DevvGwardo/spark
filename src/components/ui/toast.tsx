import * as React from 'react';
import { createPortal } from 'react-dom';
import { Info, CheckCircle, AlertTriangle, XCircle, X } from 'lucide-react';
import { toast as toastManager, subscribe, dismiss, getToasts, type ToastItem, type ToastType } from '@/lib/toast';

const toastConfig: Record<ToastType, { icon: React.ReactNode; className: string }> = {
  info: { icon: <Info className="w-5 h-5 text-blue-400" />, className: 'border-blue-500/30 bg-blue-950/50' },
  success: { icon: <CheckCircle className="w-5 h-5 text-green-400" />, className: 'border-green-500/30 bg-green-950/50' },
  warning: { icon: <AlertTriangle className="w-5 h-5 text-yellow-400" />, className: 'border-yellow-500/30 bg-yellow-950/50' },
  error: { icon: <XCircle className="w-5 h-5 text-red-400" />, className: 'border-red-500/30 bg-red-950/50' },
};

function ToastItemComponent({ item }: { item: ToastItem }) {
  const [progress, setProgress] = React.useState(100);
  const [visible, setVisible] = React.useState(true);
  const config = toastConfig[item.type];

  React.useEffect(() => {
    if (item.duration <= 0) return;
    const start = Date.now();
    const tick = () => {
      const elapsed = Date.now() - start;
      const remaining = Math.max(0, 100 - (elapsed / item.duration) * 100);
      setProgress(remaining);
      if (remaining > 0) {
        requestAnimationFrame(tick);
      }
    };
    requestAnimationFrame(tick);
  }, [item.duration]);

  const handleClose = () => {
    setVisible(false);
    setTimeout(() => dismiss(item.id), 150);
  };

  if (!visible && item.id) return null;

  return (
    <div
      className={`relative flex items-start gap-3 rounded-lg border p-4 shadow-lg backdrop-blur-sm transition-all duration-200 ${config.className}`}
      style={{ minWidth: 320, maxWidth: 400 }}
    >
      <div className="shrink-0 mt-0.5">{config.icon}</div>
      <div className="flex-1 min-w-0">
        <p className="text-sm text-zinc-100 break-words">{item.message}</p>
      </div>
      <button
        onClick={handleClose}
        className="shrink-0 rounded p-1 text-zinc-400 hover:text-zinc-100 hover:bg-white/10 transition-colors"
      >
        <X className="w-4 h-4" />
      </button>
      {item.duration > 0 && (
        <div className="absolute bottom-0 left-0 right-0 h-1 bg-black/20 rounded-b-lg overflow-hidden">
          <div
            className={`h-full transition-[width] ease-linear ${
              item.type === 'error' ? 'bg-red-500' :
              item.type === 'warning' ? 'bg-yellow-500' :
              item.type === 'success' ? 'bg-green-500' :
              'bg-blue-500'
            }`}
            style={{ width: `${progress}%` }}
          />
        </div>
      )}
    </div>
  );
}

function ToastContainer() {
  const [items, setItems] = React.useState<ToastItem[]>([]);

  React.useEffect(() => {
    setItems(getToasts());
    return subscribe(setItems);
  }, []);

  if (items.length === 0) return null;

  return createPortal(
    <div className="fixed top-4 right-4 z-[9999] flex flex-col gap-2">
      {items.slice(0, 5).map((item) => (
        <ToastItemComponent key={item.id} item={item} />
      ))}
    </div>,
    document.body
  );
}

interface ToastContextValue {
  addToast: typeof toastManager;
  dismiss: typeof dismiss;
  clear: typeof toastManager.clear;
}

const ToastContext = React.createContext<ToastContextValue | null>(null);

function ToastProvider({ children }: { children: React.ReactNode }) {
  const value = React.useMemo(
    () => ({
      addToast: toastManager,
      dismiss,
      clear: toastManager.clear,
    }),
    []
  );

  return (
    <ToastContext.Provider value={value}>
      {children}
      <ToastContainer />
    </ToastContext.Provider>
  );
}

function useToastContext(): ToastContextValue {
  const context = React.useContext(ToastContext);
  if (!context) {
    throw new Error('useToastContext must be used within ToastProvider');
  }
  return context;
}

export { ToastProvider, ToastContainer, useToastContext };
export { toast as addToast, dismiss, clear } from '@/lib/toast';