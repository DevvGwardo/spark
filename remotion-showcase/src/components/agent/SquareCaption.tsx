import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS, FONT } from '../../theme';

// Lower caption tuned for the 1080x1080 square frame.
export const SquareCaption: React.FC<{ text: string; delay?: number; out?: number }> = ({
  text,
  delay = 0,
  out,
}) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 18 }, durationInFrames: 24 });
  const fade = out !== undefined ? interpolate(frame, [out, out + 16], [1, 0], { extrapolateLeft: 'clamp', extrapolateRight: 'clamp' }) : 1;

  return (
    <div
      style={{
        position: 'absolute',
        left: 90,
        right: 90,
        bottom: 74,
        textAlign: 'center',
        opacity: s * fade,
        transform: `translateY(${interpolate(s, [0, 1], [22, 0])}px)`,
      }}
    >
      <div
        style={{
          fontFamily: FONT.sans,
          fontSize: 38,
          lineHeight: 1.2,
          fontWeight: 600,
          letterSpacing: -0.6,
          color: COLORS.text,
          textShadow: '0 4px 30px rgba(0,0,0,0.7)',
        }}
      >
        {text}
      </div>
    </div>
  );
};
