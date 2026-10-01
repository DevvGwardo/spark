import type { Transition, Variants } from 'framer-motion';

/**
 * Shared motion presets for the onboarding surfaces (setup wizard, product
 * tour, welcome empty state, bridge setup). Springs, variants, and press
 * feel live here so components can import them without mixing non-component
 * exports into component files (keeps react-refresh/HMR clean).
 *
 * Direction: "refined & on-brand" — quick, purposeful, never bouncy. Springs
 * are stiff with high damping so things settle fast with minimal overshoot,
 * matching the dark/dense "Warp meets Linear" aesthetic.
 */

/** Snappy settle — primary UI transitions, step swaps. */
export const SPRING: Transition = { type: 'spring', stiffness: 520, damping: 40, mass: 0.85 };
/** Softer settle — height/layout changes that shouldn't feel abrupt. */
export const SOFT_SPRING: Transition = { type: 'spring', stiffness: 340, damping: 36, mass: 0.9 };
/** Expo-out easing for plain fades. */
export const EASE_OUT: Transition = { duration: 0.18, ease: [0.16, 1, 0.3, 1] };

/** Container that releases its children in a staggered cascade. */
export const staggerContainer: Variants = {
  hidden: {},
  show: {
    transition: { staggerChildren: 0.055, delayChildren: 0.04 },
  },
};

/** The signature entrance: rise + fade. */
export const fadeInUp: Variants = {
  hidden: { opacity: 0, y: 12 },
  show: { opacity: 1, y: 0, transition: EASE_OUT },
};

/** Plain fade for backdrops/overlays. */
export const fadeIn: Variants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: EASE_OUT },
};

/** Pop-in for hero marks / success badges. */
export const popIn: Variants = {
  hidden: { opacity: 0, scale: 0.82, y: 6 },
  show: { opacity: 1, scale: 1, y: 0, transition: SPRING },
};

/**
 * Directional step transition for multi-step flows. `custom` is the travel
 * direction: 1 = forward (slide in from the right), -1 = backward.
 */
export const stepVariants: Variants = {
  enter: (dir: number) => ({ opacity: 0, x: dir >= 0 ? 28 : -28 }),
  center: { opacity: 1, x: 0, transition: SPRING },
  exit: (dir: number) => ({ opacity: 0, x: dir >= 0 ? -28 : 28, transition: { duration: 0.16, ease: 'easeIn' } }),
};

/** Shared hover/press feel for interactive cards and primary buttons. */
export const pressable = {
  whileHover: { scale: 1.015 },
  whileTap: { scale: 0.985 },
  transition: SPRING,
} as const;

/** Subtler press for dense list rows / secondary buttons. */
export const pressableSubtle = {
  whileHover: { scale: 1.008 },
  whileTap: { scale: 0.99 },
  transition: SPRING,
} as const;
