import { motion, type Variants } from 'framer-motion';

interface WaveTextProps {
  text: string;
  className?: string;
  /** Delay before the wave starts (seconds) */
  delay?: number;
  /** Time between each character starting its animation (seconds) */
  staggerPerChar?: number;
  /** Duration of each character's entrance (seconds) */
  charDuration?: number;
}

const container: Variants = {
  hidden: {},
  visible: {
    transition: {
      staggerChildren: 0.025,
      delayChildren: 0.4,
    },
  },
};

const glyph: Variants = {
  hidden: {
    opacity: 0,
    y: 40,
    rotateX: -40,
  },
  visible: {
    opacity: 1,
    y: 0,
    rotateX: 0,
    transition: {
      duration: 0.5,
      ease: [0.25, 0.1, 0.25, 1],
    },
  },
};

export function WaveText({
  text,
  className,
  delay = 0.4,
  staggerPerChar = 0.025,
  charDuration = 0.5,
}: WaveTextProps) {
  // Build per-instance variants so delay/stagger are configurable
  const instanceContainer: Variants = {
    hidden: {},
    visible: {
      transition: {
        staggerChildren: staggerPerChar,
        delayChildren: delay,
      },
    },
  };

  const instanceGlyph: Variants = {
    hidden: { opacity: 0, y: 40, rotateX: -45 },
    visible: {
      opacity: 1,
      y: 0,
      rotateX: 0,
      transition: {
        duration: charDuration,
        ease: [0.25, 0.1, 0.25, 1],
      },
    },
  };

  return (
    <motion.span
      variants={instanceContainer}
      initial="hidden"
      animate="visible"
      className={className}
      style={{ display: 'inline', perspective: '400px' }}
    >
      {text.split('').map((char, i) => (
        <motion.span
          key={`${char}-${i}`}
          variants={instanceGlyph}
          style={{
            display: char === ' ' ? 'inline' : 'inline-block',
            whiteSpace: char === ' ' ? 'pre' : 'normal',
            transformOrigin: 'bottom center',
          }}
        >
          {char === ' ' ? '\u00A0' : char}
        </motion.span>
      ))}
    </motion.span>
  );
}
