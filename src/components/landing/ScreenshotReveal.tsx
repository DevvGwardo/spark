import { useEffect, useRef, useState } from 'react';
import { motion } from 'framer-motion';

interface Screenshot {
  label: string;
  caption: string;
  src: string;
  alt: string;
}

const screenshots: Screenshot[] = [
  {
    label: 'Multi-model chat',
    caption: 'Talk to Claude Opus, GPT-5.4, or local Hermes — all in one interface.',
    src: '/landing/screenshots/chat.png',
    alt: 'CloudChat multi-model chat interface',
  },
  {
    label: 'Built-in terminal',
    caption: 'Agents that read, write, and run code — with full terminal access.',
    src: '/landing/screenshots/terminal.png',
    alt: 'CloudChat terminal',
  },
  {
    label: 'Parallel worktrees',
    caption: 'Fan out work across isolated git worktrees. Run agents in parallel with zero conflicts.',
    src: '/landing/screenshots/worktrees.png',
    alt: 'CloudChat worktrees',
  },
];

function ScreenshotCard({ shot, index }: { shot: Screenshot; index: number }) {
  const ref = useRef<HTMLDivElement>(null);
  const [visible, setVisible] = useState(false);
  const [imgError, setImgError] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const obs = new IntersectionObserver(
      ([entry]) => { if (entry.isIntersecting) setVisible(true); },
      { threshold: 0.15 }
    );
    obs.observe(el);
    return () => obs.disconnect();
  }, []);

  return (
    <motion.div
      ref={ref}
      initial={{ opacity: 0, y: 60 }}
      animate={visible ? { opacity: 1, y: 0 } : {}}
      transition={{ duration: 0.8, delay: index * 0.1, ease: [0.25, 0.1, 0.25, 1] }}
      className="flex flex-col items-center"
    >
      <p className="text-[10px] tracking-[0.2em] text-muted-foreground uppercase mb-8">
        {shot.label}
      </p>

      <div className="w-full max-w-4xl border border-border/20 bg-[#0d0d0d] overflow-hidden">
        {!imgError ? (
          <img
            src={shot.src}
            alt={shot.alt}
            onError={() => setImgError(true)}
            className="w-full h-auto block"
          />
        ) : (
          <div className="flex items-center justify-center aspect-video text-xs text-muted-foreground tracking-[0.05em] border border-dashed border-border/20 bg-[#0d0d0d]">
            Drop screenshot → public/landing/screenshots/{shot.src.split('/').pop()}
          </div>
        )}
      </div>

      <p className="mt-4 text-xs text-muted-foreground tracking-[0.04em] text-center max-w-md">
        {shot.caption}
      </p>
    </motion.div>
  );
}

export function ScreenshotReveal() {
  return (
    <section className="relative z-10 py-32 px-6 border-t border-border/20">
      <div className="max-w-5xl mx-auto flex flex-col gap-40">
        {screenshots.map((shot, i) => (
          <ScreenshotCard key={shot.label} shot={shot} index={i} />
        ))}
      </div>
    </section>
  );
}
