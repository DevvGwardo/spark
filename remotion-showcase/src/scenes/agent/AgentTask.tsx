import { AbsoluteFill, interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { Background } from '../../components/Background';
import { Panel } from '../../components/agent/Panel';
import { SquareCaption } from '../../components/agent/SquareCaption';
import { COLORS, FONT } from '../../theme';

const PROMPT = 'Fix the failing test in pricing.py';

export const AgentTask: React.FC = () => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const out = interpolate(frame, [134, 150], [1, 0], { extrapolateLeft: 'clamp' });

  // type the prompt out, char by char
  const typeStart = 22;
  const chars = Math.max(0, Math.min(PROMPT.length, Math.floor((frame - typeStart) / 1.6)));
  const typed = PROMPT.slice(0, chars);
  const doneTyping = chars >= PROMPT.length;
  const caret = Math.floor(frame / 8) % 2 === 0;

  // once typed, the prompt "sends": bubble springs up, Hermes starts thinking
  const sendAt = 78;
  const sent = spring({ frame: frame - sendAt, fps, config: { damping: 16 }, durationInFrames: 24 });
  const thinking = frame > sendAt + 14;

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Background />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Panel delay={4} title="Spark — New session" width={860}>
          <div style={{ minHeight: 300, display: 'flex', flexDirection: 'column', justifyContent: 'flex-end', gap: 18 }}>
            {/* sent user message */}
            {frame > sendAt && (
              <div
                style={{
                  alignSelf: 'flex-end',
                  maxWidth: '78%',
                  padding: '16px 22px',
                  borderRadius: '16px 16px 4px 16px',
                  background: COLORS.primary,
                  color: '#0B0D12',
                  fontFamily: FONT.sans,
                  fontSize: 26,
                  fontWeight: 600,
                  opacity: sent,
                  transform: `translateY(${interpolate(sent, [0, 1], [18, 0])}px)`,
                }}
              >
                {PROMPT}
              </div>
            )}

            {/* Hermes thinking */}
            {thinking && <Thinking frame={frame - sendAt - 14} />}

            {/* the live input box (hidden after send) */}
            {frame <= sendAt && (
              <div
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 14,
                  padding: '20px 22px',
                  borderRadius: 16,
                  background: 'rgba(255,255,255,0.03)',
                  border: `1px solid ${doneTyping ? COLORS.primary + '99' : COLORS.borderStrong}`,
                  boxShadow: doneTyping ? `0 0 26px ${COLORS.primary}33` : 'none',
                }}
              >
                <span style={{ fontFamily: FONT.sans, fontSize: 27, color: typed ? COLORS.text : COLORS.textFaint }}>
                  {typed || 'Ask Hermes to do something…'}
                  {!doneTyping && typed !== '' && (
                    <span style={{ opacity: caret ? 1 : 0, color: COLORS.primary }}>▍</span>
                  )}
                </span>
                <span style={{ flex: 1 }} />
                <span
                  style={{
                    width: 40,
                    height: 40,
                    borderRadius: 10,
                    background: doneTyping ? COLORS.primary : 'rgba(255,255,255,0.06)',
                    display: 'grid',
                    placeItems: 'center',
                    transition: 'background 120ms',
                  }}
                >
                  <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={doneTyping ? '#0B0D12' : COLORS.textFaint} strokeWidth={2.2} strokeLinecap="round" strokeLinejoin="round">
                    <path d="M12 19V5 M5 12l7-7 7 7" />
                  </svg>
                </span>
              </div>
            )}
          </div>
        </Panel>
      </AbsoluteFill>
      <SquareCaption text="Give Hermes a task in plain language." delay={16} out={128} />
    </AbsoluteFill>
  );
};

const Thinking: React.FC<{ frame: number }> = ({ frame }) => {
  const dots = [0, 1, 2].map((i) => interpolate(Math.sin((frame - i * 4) / 5), [-1, 1], [0.25, 1]));
  return (
    <div
      style={{
        alignSelf: 'flex-start',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 12,
        padding: '14px 20px',
        borderRadius: '16px 16px 16px 4px',
        background: 'rgba(255,255,255,0.04)',
        border: `1px solid ${COLORS.border}`,
      }}
    >
      <span style={{ fontFamily: FONT.mono, fontSize: 20, color: COLORS.cyan }}>Hermes</span>
      <span style={{ display: 'inline-flex', gap: 6 }}>
        {dots.map((o, i) => (
          <span key={i} style={{ width: 9, height: 9, borderRadius: 99, background: COLORS.textMuted, opacity: o }} />
        ))}
      </span>
    </div>
  );
};
