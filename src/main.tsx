import { createRoot } from 'react-dom/client';
import { setBasePath } from '@shoelace-style/shoelace/dist/utilities/base-path.js';
import '@fontsource/geist-sans/400.css';
import '@fontsource/geist-sans/500.css';
import '@fontsource/geist-sans/600.css';
import '@fontsource/geist-sans/700.css';
import '@fontsource/geist-mono/400.css';
import '@shoelace-style/shoelace/dist/themes/dark.css';
import App from './App.tsx';
import './index.css';
import { useActivityStore } from './stores/activity-store';

// Shoelace assets base path (icons, etc.)
setBasePath('https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.20.1/cdn/');

// Expose a global check for the Electron updater to query whether any
// conversation is actively streaming (prevents data loss on restart).
(window as any).__updateHasActiveStreams = (): boolean => {
  const activities = useActivityStore.getState().activities;
  return Object.values(activities).some((a) => a.streaming);
};

createRoot(document.getElementById("root")!).render(<App />);
