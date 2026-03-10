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

// Shoelace assets base path (icons, etc.)
setBasePath('https://cdn.jsdelivr.net/npm/@shoelace-style/shoelace@2.20.1/cdn/');

createRoot(document.getElementById("root")!).render(<App />);
