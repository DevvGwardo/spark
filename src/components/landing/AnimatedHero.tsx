import { useEffect, useState } from 'react';
import { motion, type Variants } from 'framer-motion';
import { ArrowDown } from 'lucide-react';
import { WaveText } from '@/components/landing/WaveText';

const gridLines: Variants = {
  hidden: { opacity: 0 },
  visible: {
    opacity: 1,
    transition: { duration: 1.2, ease: 'easeOut' as const },
  },
};

const fadeUp: Variants = {
  hidden: { opacity: 0, y: 40 },
  visible: {
    opacity: 1,
    y: 0,
    transition: { duration: 0.8, ease: [0.25, 0.1, 0.25, 1] as const },
  },
};

interface AnimatedHeroProps {
  onStart: () => void;
  isExiting: boolean;
}

export function AnimatedHero({ onStart, isExiting: _isExiting }: AnimatedHeroProps) {
  const [scrollHintVisible, setScrollHintVisible] = useState(true);

  useEffect(() => {
    const onScroll = () => setScrollHintVisible(window.scrollY < 20);
    window.addEventListener('scroll', onScroll, { passive: true });
    return () => window.removeEventListener('scroll', onScroll);
  }, []);

  return (
    <motion.section
      exit={{ opacity: 0, filter: 'blur(12px)', transition: { duration: 0.5, ease: 'easeIn' } }}
      className="relative flex flex-col items-center justify-center min-h-screen px-6 pt-20 pb-24 text-center overflow-hidden"
    >
      {/* Grid background */}
      <motion.div
        variants={gridLines}
        initial="hidden"
        animate="visible"
        className="absolute inset-0 pointer-events-none"
        style={{
          backgroundImage: `
            linear-gradient(hsl(var(--border) / 0.15) 1px, transparent 1px),
            linear-gradient(90deg, hsl(var(--border) / 0.15) 1px, transparent 1px)
          `,
          backgroundSize: '80px 80px',
        }}
      />

      {/* Top gradient fade */}
      <div
        className="absolute top-0 left-0 right-0 h-48 pointer-events-none"
        style={{
          background: 'linear-gradient(180deg, hsl(var(--background)) 0%, transparent 100%)',
        }}
      />

      <div className="relative z-10 max-w-3xl">
        {/* Label */}
        <motion.p
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          className="text-xs tracking-[0.2em] text-muted-foreground uppercase mb-8"
        >
          Desktop AI Coding Assistant
        </motion.p>

        {/* Title — wave animation per character */}
        <h1 className="text-[clamp(3rem,10vw,7rem)] font-semibold leading-[0.95] tracking-[-0.03em] text-foreground">
          <WaveText text="AI coding," delay={0.3} staggerPerChar={0.02} charDuration={0.45} />
          <br />
          <span className="text-primary">
            <WaveText text="amplified." delay={1.0} staggerPerChar={0.025} charDuration={0.4} />
          </span>
        </h1>

        {/* Subtitle */}
        <motion.p
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          className="mt-8 text-sm text-muted-foreground max-w-lg mx-auto leading-relaxed"
        >
          One desktop app. Every model. Claude, GPT, and local agents — unified in a
          terminal-native interface built for developers who ship.
        </motion.p>

        {/* CTA */}
        <motion.div
          variants={fadeUp}
          initial="hidden"
          animate="visible"
          className="mt-10"
        >
          <button
            onClick={onStart}
            className="inline-flex items-center gap-2 px-8 py-3 border border-foreground text-foreground text-xs tracking-[0.1em] uppercase
                       hover:bg-foreground hover:text-background transition-colors duration-200"
          >
            See it in action
          </button>
        </motion.div>
      </div>

      {/* Scroll hint */}
      <motion.div
        animate={{ opacity: scrollHintVisible ? 1 : 0, y: scrollHintVisible ? 0 : 10 }}
        transition={{ duration: 0.3 }}
        className="absolute bottom-8 flex flex-col items-center gap-2 text-[10px] tracking-[0.2em] text-muted-foreground uppercase"
      >
        <span>Scroll</span>
        <ArrowDown size={12} className="animate-bounce" />
      </motion.div>
    </motion.section>
  );
}
