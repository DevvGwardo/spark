import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../../components/Background';
import { SparkMark } from '../../components/SparkMark';
import { COLORS, FONT } from '../../theme';

export const AgentIntro: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();

  const word = spring({ frame: frame - 30, fps, config: { damping: 16 }, durationInFrames: 28 });
  const tag = spring({ frame: frame - 48, fps, config: { damping: 16 }, durationInFrames: 28 });
  const out = interpolate(frame, [118, 135], [1, 0], { extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Background />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center', flexDirection: 'column' }}>
        <SparkMark size={300} />
        <div
          style={{
            marginTop: 44,
            fontFamily: FONT.sans,
            fontSize: 128,
            fontWeight: 800,
            letterSpacing: -5,
            color: COLORS.text,
            transform: `translateY(${interpolate(word, [0, 1], [40, 0])}px)`,
            opacity: word,
          }}
        >
          Spark
        </div>
        <div
          style={{
            marginTop: 16,
            fontFamily: FONT.mono,
            fontSize: 26,
            letterSpacing: 6,
            textTransform: 'uppercase',
            color: COLORS.primary,
            transform: `translateY(${interpolate(tag, [0, 1], [22, 0])}px)`,
            opacity: tag,
          }}
        >
          A Codex-style GUI for Hermes-agent
        </div>
      </AbsoluteFill>
    </AbsoluteFill>
  );
};
