import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../components/Background';
import { SparkMark } from '../components/SparkMark';
import { COLORS, FONT } from '../theme';

// "Spark. Keep track of Hermes, effortlessly."
export const OutroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const inn = spring({ frame, fps, config: { damping: 18 }, durationInFrames: 30 });
  const tag = spring({ frame: frame - 30, fps, config: { damping: 16 }, durationInFrames: 30 });
  const line = spring({ frame: frame - 48, fps, config: { damping: 16 }, durationInFrames: 30 });

  return (
    <AbsoluteFill style={{ opacity: interpolate(frame, [0, 16], [0, 1], { extrapolateRight: 'clamp' }) }}>
      <Background />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
        <div style={{ transform: `scale(${interpolate(inn, [0, 1], [0.8, 1])})`, opacity: inn }}>
          <SparkMark size={260} spin={false} />
        </div>
        <div
          style={{
            marginTop: 40,
            display: 'flex',
            alignItems: 'baseline',
            gap: 0,
            opacity: tag,
            transform: `translateY(${interpolate(tag, [0, 1], [30, 0])}px)`,
          }}
        >
          <span style={{ fontFamily: FONT.sans, fontSize: 110, fontWeight: 800, letterSpacing: -4, color: COLORS.text }}>Spark</span>
        </div>
        <div
          style={{
            marginTop: 22,
            fontFamily: FONT.sans,
            fontSize: 40,
            fontWeight: 600,
            letterSpacing: -0.5,
            color: COLORS.textMuted,
            opacity: line,
            transform: `translateY(${interpolate(line, [0, 1], [24, 0])}px)`,
            textAlign: 'center',
          }}
        >
          Keep track of Hermes —{' '}
          <span style={{ color: COLORS.primary, fontWeight: 700 }}>effortlessly.</span>
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
