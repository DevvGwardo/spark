import { StrictMode, useEffect, useRef } from 'react'
import { createRoot } from 'react-dom/client'
import Lenis from 'lenis'
import './index.css'
import App from './App'

// Drives the viewport frame (inset gutter + border radius around the whole
// page). 0 at the top of the page → 1 once the content panel is in view, and
// back to 0 as you scroll up — the reverse of the scroll-down transition.
function updateFrame(scroll: number) {
  const progress = Math.min(Math.max(scroll / 320, 0), 1)
  document.documentElement.style.setProperty('--frame', progress.toFixed(4))
}

// The page scrolls inside a fixed, rounded frame so the sky gutter and all
// four rounded corners stay visible for the whole scroll, not just the top.
function Root() {
  const scrollRef = useRef<HTMLDivElement>(null)
  const contentRef = useRef<HTMLDivElement>(null)

  useEffect(() => {
    const wrapper = scrollRef.current!
    if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
      const onScroll = () => updateFrame(wrapper.scrollTop)
      wrapper.addEventListener('scroll', onScroll, { passive: true })
      updateFrame(wrapper.scrollTop)
      return () => wrapper.removeEventListener('scroll', onScroll)
    }
    const lenis = new Lenis({
      wrapper,
      content: contentRef.current!,
      autoRaf: true,
      anchors: true,
    })
    lenis.on('scroll', ({ scroll }: { scroll: number }) => updateFrame(scroll))
    return () => lenis.destroy()
  }, [])

  return (
    <div className="frame">
      <div className="frame-scroll" ref={scrollRef}>
        <div ref={contentRef}>
          <App />
        </div>
      </div>
    </div>
  )
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
)
