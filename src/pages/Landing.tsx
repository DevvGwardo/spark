import { useEffect, useState, useRef } from 'react';
import { motion, AnimatePresence } from 'framer-motion';
import { AnimatedHero } from '@/components/landing/AnimatedHero';
import { WaveText } from '@/components/landing/WaveText';
import { FeatureGrid } from '@/components/landing/FeatureGrid';
import { ScreenshotReveal } from '@/components/landing/ScreenshotReveal';
import { StartCta } from '@/components/landing/StartCta';

export default function Landing() {
  const screenshotsRef = useRef<HTMLDivElement>(null);
  const [scrolled, setScrolled] = useState(false);

  // Enable scrolling on landing page (the app sets overflow: hidden)
  useEffect(() => {
    const root = document.getElementById('root');
    if (root) {
      root.style.overflow = 'auto';
      root.style.height = 'auto';
    }
    document.documentElement.style.overflow = 'auto';
    document.body.style.overflow = 'auto';
    return () => {
      const root = document.getElementById('root');
      if (root) {
        root.style.overflow = '';
        root.style.height = '';
      }
      document.documentElement.style.overflow = '';
      document.body.style.overflow = '';
    };
  }, []);

  // Track scroll for nav background
  useEffect(() => {
    const onScroll = () => setScrolled(window.scrollY > 40);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  const scrollToScreenshots = () => {
    screenshotsRef.current?.scrollIntoView({ behavior: 'smooth' });
  };

  return (
    <main className="relative min-h-screen bg-background text-foreground">
      {/* Nav */}
      <motion.nav
        initial={{ y: -20, opacity: 0 }}
        animate={{ y: 0, opacity: 1 }}
        transition={{ duration: 0.6, delay: 0.2, ease: 'easeOut' }}
        className={`fixed top-0 left-0 right-0 z-50 flex items-center justify-between px-8 py-5 transition-colors duration-300 ${
          scrolled ? 'bg-background/80 backdrop-blur-xl border-b border-border/20' : 'bg-transparent'
        }`}
      >
        <div className="text-sm font-semibold tracking-[-0.02em] text-foreground">
          CloudChat
        </div>
        <button
          onClick={scrollToScreenshots}
          className="px-5 py-2 border border-foreground/30 text-foreground/80 text-[11px] tracking-[0.08em] uppercase
                     hover:border-foreground hover:text-foreground transition-colors duration-200"
        >
          See it in action
        </button>
      </motion.nav>

      <AnimatedHero onStart={scrollToScreenshots} isExiting={false} />

      <div ref={screenshotsRef}>
        <ScreenshotReveal />
      </div>

      <FeatureGrid />
      <StartCta onStart={scrollToScreenshots} />

      {/* Footer */}
      <footer className="relative z-10 border-t border-border/20 py-12 px-6">
        <div className="max-w-4xl mx-auto flex flex-col sm:flex-row justify-between gap-4 text-[11px] text-muted-foreground">
          <div>
            <span className="text-foreground font-semibold">CloudChat</span>
            <span className="mx-2 text-border/40">—</span>
            AI coding, amplified.
          </div>
          <div className="flex gap-4">
            <a href="https://github.com" className="hover:text-foreground transition-colors">GitHub</a>
            <a href="/app" className="hover:text-foreground transition-colors">Open App</a>
            <a href="#" className="hover:text-foreground transition-colors">Download</a>
          </div>
        </div>
      </footer>
    </main>
  );
}
