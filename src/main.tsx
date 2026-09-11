import { createRoot } from 'react-dom/client';
import { setBasePath } from '@shoelace-style/shoelace/dist/utilities/base-path.js';
import '@fontsource/geist-sans/400.css';
import '@fontsource/geist-sans/500.css';
import '@fontsource/geist-sans/600.css';
import '@fontsource/geist-sans/700.css';
// @ts-expect-error - no type declarations for variable font CSS import
import '@fontsource-variable/geist-mono';
import '@shoelace-style/shoelace/dist/themes/dark.css';
import App from './App.tsx';
import { QuickWindow } from './components/quick/QuickWindow';
import './index.css';
import { useActivityStore } from './stores/activity-store';
import { ToastProvider } from './components/ui/toast';
import { ErrorBoundary } from './components/ErrorBoundary';

// Shoelace assets (icons) are bundled by the shoelace-assets vite plugin into
// <outDir>/shoelace/ and fetched relative to index.html — no CDN dependency,
// so the desktop/offline build renders icons without network access.
setBasePath('./shoelace');

// Expose a global check for the Electron updater to query whether any
// conversation is actively streaming (prevents data loss on restart).
(window as typeof window & { __updateHasActiveStreams?: () => boolean }).__updateHasActiveStreams = (): boolean => {
  const activities = useActivityStore.getState().activities;
  return Object.values(activities).some((a) => a.streaming);
};

createRoot(document.getElementById("root")!).render(
  // The quick-capture window loads the same bundle with ?quick=1 — it gets a
  // minimal tree (toast + error boundary only), never the full chat shell.
  new URLSearchParams(window.location.search).get('quick') === '1' ? (
    <ToastProvider>
      <ErrorBoundary>
        <QuickWindow />
      </ErrorBoundary>
    </ToastProvider>
  ) : (
    <ToastProvider>
      <ErrorBoundary>
        <App />
      </ErrorBoundary>
    </ToastProvider>
  )
);