import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../../components/Background';
import { Panel } from '../../components/agent/Panel';
import { SquareCaption } from '../../components/agent/SquareCaption';
import { COLORS, FONT } from '../../theme';

const DIFF: { sign: ' ' | '-' | '+'; text: string }[] = [
  { sign: ' ', text: 'def calculate_cost(tokens, rate):' },
  { sign: '-', text: '    return tokens * rate / 1000' },
  { sign: '+', text: '    return tokens * rate / 1_000_000' },
];

export const AgentShip: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = interpolate(frame, [130, 145], [1, 0], { extrapolateLeft: 'clamp' });

  const pass = spring({ frame: frame - 84, fps, config: { damping: 15 }, durationInFrames: 26 });

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Background />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Panel delay={4} title="server/pricing.py — diff" width={880}>
          {/* diff */}
          <div
            style={{
              borderRadius: 14,
              overflow: 'hidden',
              border: `1px solid ${COLORS.border}`,
              background: 'rgba(0,0,0,0.25)',
            }}
          >
            {DIFF.map((d, i) => {
              const appear = 18 + i * 16;
              const s = spring({ frame: frame - appear, fps, config: { damping: 18 }, durationInFrames: 18 });
              const bg = d.sign === '+' ? COLORS.green + '14' : d.sign === '-' ? COLORS.red + '14' : 'transparent';
              const fg = d.sign === '+' ? COLORS.mint : d.sign === '-' ? '#FF9A93' : COLORS.textMuted;
              return (
                <div
                  key={i}
                  style={{
                    display: 'flex',
                    gap: 16,
                    padding: '12px 20px',
                    background: bg,
                    opacity: s,
                    transform: `translateX(${interpolate(s, [0, 1], [-16, 0])}px)`,
                  }}
                >
                  <span style={{ fontFamily: FONT.mono, fontSize: 24, color: fg, width: 14 }}>{d.sign}</span>
                  <span style={{ fontFamily: FONT.mono, fontSize: 24, color: d.sign === ' ' ? COLORS.textMuted : COLORS.text }}>
                    {d.text}
                  </span>
                </div>
              );
            })}
          </div>

          {/* pass + ship */}
          <div
            style={{
              marginTop: 24,
              display: 'flex',
              alignItems: 'center',
              gap: 16,
              opacity: pass,
              transform: `translateY(${interpolate(pass, [0, 1], [18, 0])}px)`,
            }}
          >
            <Badge color={COLORS.green} icon="M5 13l4 4L19 7" label="5 passed" />
            <Badge color={COLORS.primary} icon="M4 4h16v12H4z M4 20h10" label="fix: cost-per-token scaling" mono />
          </div>
        </Panel>
      </AbsoluteFill>
      <SquareCaption text="It reads your code, runs your tests, and ships the fix." delay={12} out={124} />
    </AbsoluteFill>
  );
};

const Badge: React.FC<{ color: string; icon: string; label: string; mono?: boolean }> = ({ color, icon, label, mono }) => (
  <div
    style={{
      display: 'inline-flex',
      alignItems: 'center',
      gap: 10,
      padding: '12px 18px',
      borderRadius: 12,
      background: color + '18',
      border: `1px solid ${color}55`,
    }}
  >
    <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
      <path d={icon} />
    </svg>
    <span style={{ fontFamily: mono ? FONT.mono : FONT.sans, fontSize: 23, fontWeight: 600, color }}>{label}</span>
  </div>
);
