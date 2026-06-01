import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS, FONT } from '../theme';

// Animated count-up number (e.g. token totals, session counts).
export const Counter: React.FC<{
  to: number;
  delay?: number;
  dur?: number;
  prefix?: string;
  suffix?: string;
  decimals?: number;
  compact?: boolean;
  style?: React.CSSProperties;
}> = ({ to, delay = 0, dur = 40, prefix = '', suffix = '', decimals = 0, compact = false, style }) => {
  const frame = useCurrentFrame();
  const p = interpolate(frame - delay, [0, dur], [0, 1], {
    extrapolateLeft: 'clamp',
    extrapolateRight: 'clamp',
  });
  const eased = 1 - Math.pow(1 - p, 3);
  const v = to * eased;
  const text = compact ? fmtCompact(v) : v.toFixed(decimals).replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return (
    <span style={{ fontFamily: FONT.mono, fontVariantNumeric: 'tabular-nums', ...style }}>
      {prefix}
      {text}
      {suffix}
    </span>
  );
};

function fmtCompact(n: number): string {
  if (n >= 1_000_000) return (n / 1_000_000).toFixed(1) + 'M';
  if (n >= 1_000) return (n / 1_000).toFixed(1) + 'K';
  return Math.round(n).toString();
}

// A floating callout pill that springs in.
export const Callout: React.FC<{
  children: React.ReactNode;
  delay?: number;
  accent?: string;
  style?: React.CSSProperties;
}> = ({ children, delay = 0, accent = COLORS.primary, style }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 14, mass: 0.7 }, durationInFrames: 30 });
  return (
    <div
      style={{
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 22px',
        borderRadius: 16,
        background: 'rgba(20,23,31,0.82)',
        backdropFilter: 'blur(14px)',
        border: `1px solid ${accent}66`,
        boxShadow: `0 10px 40px rgba(0,0,0,0.5), 0 0 30px ${accent}22`,
        color: COLORS.text,
        fontFamily: FONT.sans,
        fontSize: 30,
        fontWeight: 600,
        letterSpacing: -0.2,
        transform: `translateY(${interpolate(s, [0, 1], [26, 0])}px) scale(${interpolate(s, [0, 1], [0.9, 1])})`,
        opacity: s,
        ...style,
      }}
    >
      <span style={{ width: 10, height: 10, borderRadius: 99, background: accent, boxShadow: `0 0 14px ${accent}` }} />
      {children}
    </div>
  );
};

// Kinetic lower-third caption (one line of the script).
export const Caption: React.FC<{ text: string; delay?: number; sub?: string }> = ({ text, delay = 0, sub }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 16 }, durationInFrames: 26 });
  return (
    <div
      style={{
        position: 'absolute',
        left: 70,
        right: 70,
        bottom: 150,
        textAlign: 'center',
        transform: `translateY(${interpolate(s, [0, 1], [30, 0])}px)`,
        opacity: s,
      }}
    >
      {sub && (
        <div
          style={{
            fontFamily: FONT.mono,
            fontSize: 22,
            letterSpacing: 4,
            textTransform: 'uppercase',
            color: COLORS.primary,
            marginBottom: 14,
          }}
        >
          {sub}
        </div>
      )}
      <div
        style={{
          fontFamily: FONT.sans,
          fontSize: 46,
          lineHeight: 1.15,
          fontWeight: 700,
          letterSpacing: -1,
          color: COLORS.text,
          textShadow: '0 4px 30px rgba(0,0,0,0.6)',
        }}
      >
        {text}
      </div>
    </div>
  );
};
