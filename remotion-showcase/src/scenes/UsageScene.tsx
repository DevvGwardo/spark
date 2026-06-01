import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Background } from '../components/Background';
import { DeviceFrame } from '../components/DeviceFrame';
import { Callout, Caption, Counter } from '../components/Bits';
import { SectionKicker } from './OverviewScene';
import { COLORS, FONT } from '../theme';

// "Usage? Crystal clear. Tokens in, tokens out, cost per model."
export const UsageScene: React.FC = () => {
  const frame = useCurrentFrame();
  const out = interpolate(frame, [220, 240], [1, 0], { extrapolateLeft: 'clamp' });

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Background glow={COLORS.cyan} />

      <div style={{ position: 'absolute', top: 150, left: 0, right: 0, textAlign: 'center' }}>
        <SectionKicker text="Usage" />
      </div>

      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <DeviceFrame src="screens/03-usage-top.png" width={580} delay={6} label="Hermes · Usage" zoom={[1.02, 1.1]} panY={[0, -14]} />
      </AbsoluteFill>

      <div style={{ position: 'absolute', top: 460, left: 64 }}>
        <Callout delay={30} accent={COLORS.cyan}>
          <BigStat label="Total Tokens" value={<Counter to={768_500_000} delay={36} compact />} />
        </Callout>
      </div>
      <div style={{ position: 'absolute', top: 640, right: 64 }}>
        <Callout delay={44} accent={COLORS.green}>
          <BigStat label="Cost" value={<Counter to={460.22} delay={50} prefix="$" decimals={2} />} />
        </Callout>
      </div>
      <div style={{ position: 'absolute', bottom: 560, left: 64 }}>
        <Callout delay={58} accent={COLORS.primary}>
          <BigStat label="Tool Calls" value={<Counter to={64_200} delay={64} compact />} />
        </Callout>
      </div>

      <Caption text="Tokens in, tokens out, cost per model — in real time." delay={80} />
    </AbsoluteFill>
  );
};

const BigStat: React.FC<{ label: string; value: React.ReactNode }> = ({ label, value }) => (
  <div style={{ textAlign: 'left' }}>
    <div style={{ fontSize: 18, letterSpacing: 2, textTransform: 'uppercase', color: COLORS.textFaint, fontFamily: FONT.sans }}>
      {label}
    </div>
    <div style={{ fontSize: 44, fontWeight: 700, color: COLORS.text, lineHeight: 1.1 }}>{value}</div>
  </div>
);
