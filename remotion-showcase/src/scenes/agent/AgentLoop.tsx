import { AbsoluteFill, interpolate, useCurrentFrame } from 'remotion';
import { Background } from '../../components/Background';
import { Panel } from '../../components/agent/Panel';
import { ToolRow, type Status } from '../../components/agent/ToolRow';
import { SquareCaption } from '../../components/agent/SquareCaption';
import { COLORS, FONT } from '../../theme';

type Step = {
  tool: string;
  arg: string;
  appear: number;
  runUntil?: number; // while frame < runUntil, status = 'run'
  status: Status; // resolved status
  result: string; // resolved result
  running?: string; // label while running
};

// Real hermes-agent tools, authentic loop: plan → read → reproduce → patch → verify.
const STEPS: Step[] = [
  { tool: 'todo', arg: 'reproduce → patch → verify', appear: 20, status: 'ok', result: '3 steps' },
  { tool: 'read_file', arg: 'server/pricing.py', appear: 46, status: 'ok', result: 'read' },
  { tool: 'terminal', arg: 'pytest -k pricing', appear: 74, runUntil: 100, status: 'fail', result: '1 failed', running: 'running' },
  { tool: 'patch', arg: 'server/pricing.py', appear: 118, status: 'ok', result: '+3 −1' },
  { tool: 'terminal', arg: 'pytest -k pricing', appear: 148, runUntil: 176, status: 'ok', result: '5 passed', running: 'running' },
];

export const AgentLoop: React.FC = () => {
  const frame = useCurrentFrame();
  const out = interpolate(frame, [206, 220], [1, 0], { extrapolateLeft: 'clamp' });

  const visible = STEPS.filter((s) => frame >= s.appear);
  const step = Math.min(visible.length, STEPS.length);

  return (
    <AbsoluteFill style={{ opacity: out }}>
      <Background />
      <AbsoluteFill style={{ alignItems: 'center', justifyContent: 'center' }}>
        <Panel delay={0} title="Spark — Hermes Agent" width={900}>
          {/* loop header */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, marginBottom: 22 }}>
            <Spinner frame={frame} />
            <span style={{ fontFamily: FONT.mono, fontSize: 22, color: COLORS.text, fontWeight: 600 }}>
              agent loop
            </span>
            <span style={{ flex: 1 }} />
            <span style={{ fontFamily: FONT.mono, fontSize: 20, color: COLORS.textMuted }}>
              step {step} / {STEPS.length}
            </span>
          </div>

          {visible.map((s, i) => {
            const running = s.runUntil !== undefined && frame < s.runUntil;
            return (
              <ToolRow
                key={i}
                tool={s.tool}
                arg={s.arg}
                status={running ? 'run' : s.status}
                result={running ? s.running ?? 'running' : s.result}
                delay={s.appear}
                last={i === STEPS.length - 1}
              />
            );
          })}
        </Panel>
      </AbsoluteFill>
      <SquareCaption text="Spark drives the Hermes agent loop — every tool call, streamed live." delay={16} out={198} />
    </AbsoluteFill>
  );
};

const Spinner: React.FC<{ frame: number }> = ({ frame }) => (
  <svg width={24} height={24} viewBox="0 0 24 24" style={{ transform: `rotate(${frame * 9}deg)` }}>
    <circle cx="12" cy="12" r="9" fill="none" stroke={COLORS.border} strokeWidth="3" />
    <path d="M12 3 a9 9 0 0 1 9 9" fill="none" stroke={COLORS.primary} strokeWidth="3" strokeLinecap="round" />
  </svg>
);
