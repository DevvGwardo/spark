import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../../components/Background';
import { Panel } from '../../components/agent/Panel';
import { SquareCaption } from '../../components/agent/SquareCaption';
import { COLORS, FONT } from '../../theme';

const OPTIONS = ['Once', 'This session', 'Always'];
const PICK = 1; // highlight "This session"

export const AgentApprove: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = interpolate(frame, [126, 140], [1, 0], { extrapolateLeft: 'clamp' });

  // selection lands around frame 74
  const select = spring({ frame: frame - 74, fps, config: { damping: 14 }, durationInFrames: 18 });

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Background />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Panel delay={4} title="Spark — Hermes Agent" width={840}>
          {/* approval prompt */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 20 }}>
            <span
              style={{
                width: 40,
                height: 40,
                borderRadius: 10,
                background: COLORS.primary + '1A',
                border: `1px solid ${COLORS.primary}55`,
                display: 'grid',
                placeItems: 'center',
              }}
            >
              <svg width={22} height={22} viewBox="0 0 24 24" fill="none" stroke={COLORS.primary} strokeWidth={2} strokeLinecap="round" strokeLinejoin="round">
                <path d="M12 2l8 4v6c0 5-3.5 8-8 10-4.5-2-8-5-8-10V6z" />
              </svg>
            </span>
            <span style={{ fontFamily: FONT.sans, fontSize: 27, fontWeight: 600, color: COLORS.text }}>
              Hermes wants to run a command
            </span>
          </div>

          {/* command */}
          <div
            style={{
              padding: '18px 22px',
              borderRadius: 12,
              background: 'rgba(0,0,0,0.3)',
              border: `1px solid ${COLORS.border}`,
              fontFamily: FONT.mono,
              fontSize: 24,
              color: COLORS.mint,
              marginBottom: 26,
            }}
          >
            <span style={{ color: COLORS.textFaint }}>$ </span>
            git commit -m <span style={{ color: COLORS.text }}>"fix: cost scaling"</span>
          </div>

          {/* approval scopes */}
          <div style={{ display: 'flex', gap: 14 }}>
            {OPTIONS.map((label, i) => {
              const appear = spring({ frame: frame - (40 + i * 8), fps, config: { damping: 16 }, durationInFrames: 18 });
              const active = i === PICK;
              const glow = active ? select : 0;
              return (
                <div
                  key={label}
                  style={{
                    flex: 1,
                    textAlign: 'center',
                    padding: '16px 0',
                    borderRadius: 12,
                    fontFamily: FONT.sans,
                    fontSize: 23,
                    fontWeight: 600,
                    color: active ? '#0B0D12' : COLORS.text,
                    background: active
                      ? `rgba(255,143,63,${interpolate(glow, [0, 1], [0.15, 1])})`
                      : 'rgba(255,255,255,0.04)',
                    border: `1px solid ${active ? COLORS.primary : COLORS.border}`,
                    boxShadow: active ? `0 0 ${interpolate(glow, [0, 1], [0, 30])}px ${COLORS.primary}66` : 'none',
                    opacity: appear,
                    transform: `translateY(${interpolate(appear, [0, 1], [16, 0])}px) scale(${active ? interpolate(glow, [0, 1], [1, 1.04]) : 1})`,
                  }}
                >
                  {label}
                </div>
              );
            })}
          </div>
        </Panel>
      </AbsoluteFill>
      <SquareCaption text="Every tool call is visible — approve once, per session, or always." delay={12} out={120} />
    </AbsoluteFill>
  );
};
