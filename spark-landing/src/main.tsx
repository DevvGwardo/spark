import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import Lenis from 'lenis'
import './index.css'
import App from './App'

// Drives the content panel's scroll-in frame (inset margin + border radius).
// 0 at the top of the page → 1 once the panel has scrolled into view.
function updateFrame(scroll: number) {
  const progress = Math.min(Math.max(scroll / 320, 0), 1)
  document.documentElement.style.setProperty('--frame', progress.toFixed(4))
}

const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
if (reduceMotion) {
  window.addEventListener('scroll', () => updateFrame(window.scrollY), { passive: true })
  updateFrame(window.scrollY)
} else {
  const lenis = new Lenis({ autoRaf: true, anchors: true })
  lenis.on('scroll', ({ scroll }: { scroll: number }) => updateFrame(scroll))
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
