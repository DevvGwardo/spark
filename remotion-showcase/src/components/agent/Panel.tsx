import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS, FONT, GRADIENTS } from '../../theme';

// The Spark app window — minimal macOS-style chrome hosting each scene's content.
export const Panel: React.FC<{
  children: React.ReactNode;
  title?: string;
  delay?: number;
  width?: number;
  style?: React.CSSProperties;
  bodyStyle?: React.CSSProperties;
}> = ({ children, title = 'Spark — Hermes Agent', delay = 0, width = 880, style, bodyStyle }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - delay, fps, config: { damping: 18, mass: 0.9 }, durationInFrames: 32 });
  const lift = interpolate(enter, [0, 1], [44, 0]);

  return (
    <div
      style={{
        width,
        borderRadius: 24,
        background: GRADIENTS.plate,
        border: `1px solid ${COLORS.borderStrong}`,
        boxShadow: '0 50px 130px rgba(0,0,0,0.7), 0 0 0 1px rgba(255,255,255,0.03) inset',
        overflow: 'hidden',
        opacity: enter,
        transform: `translateY(${lift}px) scale(${interpolate(enter, [0, 1], [0.94, 1])})`,
        ...style,
      }}
    >
      <div
        style={{
          height: 52,
          display: 'flex',
          alignItems: 'center',
          gap: 9,
          padding: '0 20px',
          background: 'rgba(255,255,255,0.03)',
          borderBottom: `1px solid ${COLORS.border}`,
        }}
      >
        <span style={{ width: 12, height: 12, borderRadius: 99, background: '#FF5F57' }} />
        <span style={{ width: 12, height: 12, borderRadius: 99, background: '#FEBC2E' }} />
        <span style={{ width: 12, height: 12, borderRadius: 99, background: '#28C840' }} />
        <span
          style={{
            marginLeft: 16,
            fontFamily: FONT.mono,
            fontSize: 18,
            color: COLORS.textFaint,
            letterSpacing: 0.3,
          }}
        >
          {title}
        </span>
      </div>
      <div style={{ padding: 28, ...bodyStyle }}>{children}</div>
    </div>
  );
};
