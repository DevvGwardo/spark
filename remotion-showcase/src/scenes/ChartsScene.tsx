import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../components/Background';
import { DeviceFrame } from '../components/DeviceFrame';
import { Caption } from '../components/Bits';
import { SectionKicker } from './OverviewScene';
import { COLORS, FONT, GRADIENTS } from '../theme';

// "Watch your activity trend across the week, model by model."
const DAYS = [38, 52, 30, 74, 61, 88, 96]; // relative % heights — illustrative
const LABELS = ['05/26', '05/27', '05/28', '05/29', '05/30', '05/31', '06/01'];

export const ChartsScene: React.FC = () => {
  const frame = useCurrentFrame();
  const out = interpolate(frame, [190, 210], [1, 0], { extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Background glow={COLORS.primaryGlow} />

      <div style={{ position: 'absolute', top: 150, left: 0, right: 0, textAlign: 'center' }}>
        <SectionKicker text="Trends" />
      </div>

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'flex-start', paddingTop: 260 }}>
        <DeviceFrame src="screens/04-charts.png" width={560} delay={6} label="Hermes · Activity" zoom={[1.04, 1.14]} panY={[10, -20]} />
      </AbsoluteFill>

      {/* native animated histogram overlay card */}
      <BarCard />

      <Caption text="Your activity trend, model by model." delay={86} />
    </AbsoluteFill>
  );
};

const BarCard: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const enter = spring({ frame: frame - 30, fps, config: { damping: 16 }, durationInFrames: 28 });
  return (
    <div
      style={{
        position: 'absolute',
        left: 90,
        right: 90,
        bottom: 470,
        padding: '28px 30px 22px',
        borderRadius: 22,
        background: 'rgba(15,18,24,0.82)',
        backdropFilter: 'blur(14px)',
        border: `1px solid ${COLORS.border}`,
        boxShadow: '0 24px 70px rgba(0,0,0,0.55)',
        opacity: enter,
        transform: `translateY(${interpolate(enter, [0, 1], [30, 0])}px)`,
      }}
    >
      <div style={{ fontFamily: FONT.mono, fontSize: 20, letterSpacing: 3, textTransform: 'uppercase', color: COLORS.textMuted, marginBottom: 22 }}>
        Recent Activity · 7 days
      </div>
      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 16, height: 220 }}>
        {DAYS.map((h, i) => {
          const grow = spring({ frame: frame - 40 - i * 5, fps, config: { damping: 14 }, durationInFrames: 26 });
          return (
            <div key={i} style={{ flex: 1, display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 12 }}>
              <div style={{ width: '100%', height: 200, display: 'flex', alignItems: 'flex-end', background: 'rgba(255,255,255,0.03)', borderRadius: 10, padding: 6 }}>
                <div
                  style={{
                    width: '100%',
                    height: `${h * grow}%`,
                    borderRadius: 7,
                    background: GRADIENTS.activity,
                    boxShadow: `0 0 18px ${COLORS.primary}55`,
                  }}
                />
              </div>
              <div style={{ fontFamily: FONT.mono, fontSize: 16, color: COLORS.textFaint }}>{LABELS[i]}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
};
