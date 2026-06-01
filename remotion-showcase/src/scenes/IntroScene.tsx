import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../components/Background';
import { SparkMark } from '../components/SparkMark';
import { COLORS, FONT } from '../theme';

export const IntroScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const wordmark = spring({ frame: frame - 34, fps, config: { damping: 16 }, durationInFrames: 30 });
  const tag = spring({ frame: frame - 54, fps, config: { damping: 16 }, durationInFrames: 30 });
  const out = interpolate(frame, [130, 150], [1, 0], { extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Background />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
        <SparkMark size={360} />
        <div
          style={{
            marginTop: 56,
            fontFamily: FONT.sans,
            fontSize: 132,
            fontWeight: 800,
            letterSpacing: -4,
            color: COLORS.text,
            transform: `translateY(${interpolate(wordmark, [0, 1], [40, 0])}px)`,
            opacity: wordmark,
          }}
        >
          Spark
        </div>
        <div
          style={{
            marginTop: 18,
            fontFamily: FONT.mono,
            fontSize: 28,
            letterSpacing: 8,
            textTransform: 'uppercase',
            color: COLORS.primary,
            transform: `translateY(${interpolate(tag, [0, 1], [24, 0])}px)`,
            opacity: tag,
          }}
        >
          Your Hermes command center
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
