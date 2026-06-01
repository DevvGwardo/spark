import { AbsoluteFill, useCurrentFrame } from 'remotion';
import { COLORS } from '../theme';

// Dark-native backdrop: deep plate, a slow-drifting orange glow, and a faint grid.
export const Background: React.FC<{ glow?: string }> = ({ glow = COLORS.primary }) => {
  const frame = useCurrentFrame();
  const drift = Math.sin(frame / 90) * 60;
  const drift2 = Math.cos(frame / 120) * 80;

  return (
    <AbsoluteFill style={{ background: COLORS.bg }}>
      {/* primary glow */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(620px 620px at ${540 + drift}px ${620 + drift2}px, ${glow}26, transparent 70%)`,
        }}
      />
      {/* secondary cool glow for depth */}
      <AbsoluteFill
        style={{
          background: `radial-gradient(520px 520px at ${560 - drift}px ${1400 - drift2}px, ${COLORS.cyan}14, transparent 70%)`,
        }}
      />
      {/* faint grid */}
      <AbsoluteFill
        style={{
          backgroundImage: `linear-gradient(${COLORS.border} 1px, transparent 1px), linear-gradient(90deg, ${COLORS.border} 1px, transparent 1px)`,
          backgroundSize: '72px 72px',
          opacity: 0.35,
          maskImage: 'radial-gradient(ellipse 80% 70% at 50% 45%, black, transparent 100%)',
          WebkitMaskImage: 'radial-gradient(ellipse 80% 70% at 50% 45%, black, transparent 100%)',
        }}
      />
      {/* vignette */}
      <AbsoluteFill
        style={{
          background: 'radial-gradient(ellipse 90% 90% at 50% 50%, transparent 55%, rgba(0,0,0,0.55) 100%)',
        }}
      />
    </AbsoluteFill>
  );
};
