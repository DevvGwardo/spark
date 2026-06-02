import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../../components/Background';
import { SparkMark } from '../../components/SparkMark';
import { COLORS, FONT } from '../../theme';

export const AgentOutro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const inn = spring({ frame, fps, config: { damping: 18 }, durationInFrames: 28 });
  const tag = spring({ frame: frame - 26, fps, config: { damping: 16 }, durationInFrames: 28 });
  const url = spring({ frame: frame - 46, fps, config: { damping: 16 }, durationInFrames: 28 });

  return (
    <AbsoluteFill style={{ opacity: interpolate(frame, [0, 14], [0, 1], { extrapolateRight: 'clamp' }) }}>
      <Background />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
        <div style={{ transform: `scale(${interpolate(inn, [0, 1], [0.8, 1])})`, opacity: inn }}>
          <SparkMark size={230} spin={false} />
        </div>
        <div
          style={{
            marginTop: 36,
            fontFamily: FONT.sans,
            fontSize: 104,
            fontWeight: 800,
            letterSpacing: -4,
            color: COLORS.text,
            opacity: tag,
            transform: `translateY(${interpolate(tag, [0, 1], [28, 0])}px)`,
          }}
        >
          Spark
        </div>
        <div
          style={{
            marginTop: 18,
            fontFamily: FONT.sans,
            fontSize: 36,
            fontWeight: 600,
            letterSpacing: -0.5,
            color: COLORS.textMuted,
            opacity: tag,
            transform: `translateY(${interpolate(tag, [0, 1], [22, 0])}px)`,
            textAlign: 'center',
          }}
        >
          The GUI for <span style={{ color: COLORS.primary, fontWeight: 700 }}>Hermes-agent.</span>
        </div>
        <div
          style={{
            marginTop: 40,
            fontFamily: FONT.mono,
            fontSize: 24,
            letterSpacing: 2,
            color: COLORS.textFaint,
            opacity: url,
          }}
        >
          powered by Hermes · Nous Research
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
