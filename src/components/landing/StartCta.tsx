import { motion } from 'framer-motion';

interface StartCtaProps {
  onStart: () => void;
}

export function StartCta({ onStart }: StartCtaProps) {
  return (
    <section className="relative z-10 py-48 px-6 border-t border-border/20 flex flex-col items-center text-center">
      <motion.p
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, ease: 'easeOut' }}
        className="text-2xl font-semibold tracking-[-0.02em] text-foreground mb-4"
      >
        Ready to ship faster?
      </motion.p>

      <motion.p
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, delay: 0.1, ease: 'easeOut' }}
        className="text-sm text-muted-foreground mb-10 max-w-sm leading-relaxed"
      >
        Download for macOS — Apple Silicon &amp; Intel. Start building with AI agents in under a minute.
      </motion.p>

      <motion.div
        initial={{ opacity: 0, y: 20 }}
        whileInView={{ opacity: 1, y: 0 }}
        viewport={{ once: true }}
        transition={{ duration: 0.6, delay: 0.2, ease: 'easeOut' }}
      >
        <button
          onClick={onStart}
          className="inline-flex items-center gap-2 px-8 py-3 border border-foreground text-foreground text-xs tracking-[0.1em] uppercase
                     hover:bg-foreground hover:text-background transition-colors duration-200"
        >
          Get started
        </button>
      </motion.div>
    </section>
  );
}
