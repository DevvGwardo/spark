import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Background } from '../components/Background';
import { DeviceFrame } from '../components/DeviceFrame';
import { Callout, Caption, Counter } from '../components/Bits';
import { COLORS, FONT } from '../theme';

// "Track every Hermes session at a glance."
export const OverviewScene: React.FC = () => {
  const frame = useCurrentFrame();
  const out = interpolate(frame, [250, 270], [1, 0], { extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Background glow={COLORS.primary} />

      <div style={{ position: 'absolute', top: 150, left: 0, right: 0, textAlign: 'center' }}>
        <SectionKicker text="Overview" />
      </div>

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <DeviceFrame src="screens/02-overview.png" width={540} delay={6} label="Hermes · Overview" zoom={[1.02, 1.1]} panY={[0, -16]} />
      </AbsoluteFill>

      {/* floating stat callouts */}
      <div style={{ position: 'absolute', top: 470, left: 70 }}>
        <Callout delay={28} accent={COLORS.primary}>
          <Stat label="Tracked Sessions" value={<Counter to={12100} delay={34} compact />} />
        </Callout>
      </div>
      <div style={{ position: 'absolute', top: 470, right: 70 }}>
        <Callout delay={40} accent={COLORS.green}>
          <Stat label="Live" value={<Counter to={3} delay={46} />} />
        </Callout>
      </div>
      <div style={{ position: 'absolute', bottom: 540, left: 70 }}>
        <Callout delay={52} accent={COLORS.cyan}>
          <Stat label="Cron Jobs" value={<Counter to={8} delay={58} />} />
        </Callout>
      </div>
      <div style={{ position: 'absolute', bottom: 540, right: 70 }}>
        <Callout delay={64} accent={COLORS.mint}>
          <Stat label="Skills" value={<Counter to={286} delay={70} />} />
        </Callout>
      </div>

      <Caption text="Every session your agent runs — tracked in one place." delay={90} />
    </AbsoluteFill>
  );
};

const Stat: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div style={{ textAlign: 'left' }}>
    <div style={{ fontSize: 18, letterSpacing: 2, textTransform: 'uppercase', color: COLORS.textFaint, fontFamily: FONT.sans }}>
      {label}
    </div>
    <div style={{ fontSize: 40, fontWeight: 700, color: COLORS.text, lineHeight: 1.1 }}>{value}</div>
  </div>
);

export const SectionKicker: React.FC<{ text: string }> = ({ text }) => (
  <span
    style={{
      fontFamily: FONT.mono,
      fontSize: 24,
      letterSpacing: 6,
      textTransform: 'uppercase',
      color: COLORS.primary,
      padding: '10px 22px',
      borderRadius: 999,
      border: `1px solid ${COLORS.primary}44`,
      background: 'rgba(255,143,63,0.08)',
    }}
  >
    {text}
  </span>
);
