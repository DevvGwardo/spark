import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../components/Background';
import { DeviceFrame } from '../components/DeviceFrame';
import { Caption } from '../components/Bits';
import { SectionKicker } from './OverviewScene';
import { COLORS, FONT } from '../theme';

// "Every chat is right there — replay any conversation, any session."
export const ChatsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = interpolate(frame, [280, 300], [1, 0], { extrapolateLeft: 'clamp' });

  const sessionsIn = spring({ frame: frame - 6, fps, config: { damping: 18 }, durationInFrames: 34 });
  const chatIn = spring({ frame: frame - 40, fps, config: { damping: 18 }, durationInFrames: 34 });

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Background glow={COLORS.cyan} />

      <div style={{ position: 'absolute', top: 150, left: 0, right: 0, textAlign: 'center' }}>
        <SectionKicker text="Sessions" />
      </div>

      {/* sessions list peeking behind */}
      <div
        style={{
          position: 'absolute',
          top: 420,
          left: 70,
          transform: `translateX(${interpolate(sessionsIn, [0, 1], [-80, 0])}px) rotate(-4deg)`,
          opacity: sessionsIn * 0.96,
        }}
      >
        <DeviceFrame src="screens/05-sessions.png" width={420} delay={6} label="Sessions" zoom={[1.02, 1.08]} />
      </div>

      {/* open chat in front */}
      <div
        style={{
          position: 'absolute',
          top: 560,
          right: 60,
          transform: `translateX(${interpolate(chatIn, [0, 1], [90, 0])}px) rotate(3deg)`,
          opacity: chatIn,
          zIndex: 2,
        }}
      >
        <DeviceFrame src="screens/06-chat.png" width={620} delay={40} label="Chat · replay" zoom={[1.03, 1.1]} />
      </div>

      {/* replay pill */}
      <ReplayPill />

      <Caption text="Replay any conversation, any session — instantly." delay={120} />
    </AbsoluteFill>
  );
};

const ReplayPill: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - 90, fps, config: { damping: 14 }, durationInFrames: 26 });
  const dot = (frame % 30) / 30;
  return (
    <div
      style={{
        position: 'absolute',
        top: 470,
        right: 110,
        zIndex: 3,
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 22px',
        borderRadius: 999,
        background: 'rgba(20,23,31,0.9)',
        border: `1px solid ${COLORS.green}66`,
        boxShadow: `0 10px 40px rgba(0,0,0,0.5), 0 0 26px ${COLORS.green}33`,
        fontFamily: FONT.sans,
        fontSize: 26,
        fontWeight: 600,
        color: COLORS.text,
        opacity: s,
        transform: `scale(${interpolate(s, [0, 1], [0.85, 1])})`,
      }}
    >
      <span style={{ width: 12, height: 12, borderRadius: 99, background: COLORS.green, opacity: 0.5 + dot * 0.5, boxShadow: `0 0 14px ${COLORS.green}` }} />
      Live replay
    </div>
  );
};
