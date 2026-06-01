import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';

// Recreated Spark logo mark (matches src/assets/spark-mark.svg) with entrance animation.
export const SparkMark: React.FC<{ size?: number; delay?: number; spin?: boolean }> = ({
  size = 320,
  delay = 0,
  spin = true,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const f = frame - delay;

  const pop = spring({ frame: f, fps, config: { damping: 12, mass: 0.8 }, durationInFrames: 40 });
  const ringSpin = spin ? interpolate(f, [0, 90], [-40, 0], { extrapolateRight: 'clamp' }) : 0;
  const pulse = 1 + Math.sin(f / 14) * 0.015;
  const glow = interpolate(Math.sin(f / 18), [-1, 1], [0.55, 1]);

  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 512 512"
      fill="none"
      style={{ transform: `scale(${pop * pulse})`, filter: `drop-shadow(0 0 ${40 * glow}px rgba(255,143,63,${0.45 * glow}))` }}
    >
      <defs>
        <linearGradient id="plate" x1="96" y1="72" x2="432" y2="440" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#1A1D24" />
          <stop offset="55%" stopColor="#11141B" />
          <stop offset="100%" stopColor="#0B0D12" />
        </linearGradient>
        <linearGradient id="ring" x1="146" y1="122" x2="366" y2="392" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFCF70" />
          <stop offset="50%" stopColor="#FF8B2B" />
          <stop offset="100%" stopColor="#FF5A36" />
        </linearGradient>
        <radialGradient id="coreGlow" cx="0" cy="0" r="1" gradientUnits="userSpaceOnUse" gradientTransform="translate(256 244) rotate(90) scale(120)">
          <stop offset="0%" stopColor="#FFD98B" stopOpacity="0.95" />
          <stop offset="100%" stopColor="#FFD98B" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="sparkFill" x1="256" y1="168" x2="256" y2="328" gradientUnits="userSpaceOnUse">
          <stop offset="0%" stopColor="#FFF4C7" />
          <stop offset="55%" stopColor="#FFD36B" />
          <stop offset="100%" stopColor="#FFAA3B" />
        </linearGradient>
      </defs>

      <rect x="56" y="56" width="400" height="400" rx="104" fill="url(#plate)" />
      <rect x="58.5" y="58.5" width="395" height="395" rx="101.5" stroke="#FFFFFF" strokeOpacity="0.08" strokeWidth="5" />
      <circle cx="256" cy="256" r="118" fill="url(#coreGlow)" style={{ opacity: glow }} />
      <g style={{ transformOrigin: '256px 256px', transform: `rotate(${ringSpin}deg)` }}>
        <circle cx="256" cy="256" r="92" stroke="url(#ring)" strokeWidth="22" />
      </g>
      <circle cx="256" cy="256" r="66" fill="#0F1218" fillOpacity="0.72" />

      <g fill="url(#sparkFill)" style={{ transformOrigin: '256px 256px', transform: `scale(${interpolate(pop, [0, 1], [0.4, 1])})` }}>
        <path d="M256 174 L278 234 L338 256 L278 278 L256 338 L234 278 L174 256 L234 234 Z" />
        <path d="M332 176 L340 198 L362 206 L340 214 L332 236 L324 214 L302 206 L324 198 Z" />
        <path d="M180 300 L186 316 L202 322 L186 328 L180 344 L174 328 L158 322 L174 316 Z" />
      </g>
    </svg>
  );
};
