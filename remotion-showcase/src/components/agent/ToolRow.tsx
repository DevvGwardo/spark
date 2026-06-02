import { interpolate, spring, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS, FONT } from '../../theme';

export type Status = 'run' | 'ok' | 'fail';

// Real hermes-agent tool names (agent/conversation_loop.py + tools registry).
const ICONS: Record<string, string> = {
  todo: 'M4 6h10 M4 12h10 M4 18h7 M17 6l2 2 3-3 M17 14l2 2 3-3',
  read_file: 'M4 2h7l5 5v15H4z M11 2v5h5',
  search_files: 'M11 4a7 7 0 105 12l5 5 M11 4a7 7 0 010 14',
  terminal: 'M3 4h18v16H3z M7 9l4 3-4 3 M13 15h5',
  patch: 'M4 2h7l5 5v15H4z M9 16l8-8 2 2-8 8H9z',
};

const STATUS_COLOR: Record<Status, string> = {
  run: COLORS.cyan,
  ok: COLORS.green,
  fail: COLORS.red,
};

// One row in the agent's tool-call loop: glyph · tool name · argument · result chip.
export const ToolRow: React.FC<{
  tool: string;
  arg: string;
  status: Status;
  result: string;
  delay?: number;
  last?: boolean;
}> = ({ tool, arg, status, result, delay = 0, last = false }) => {
  const frame = useCurrentFrame();
  const { fps } = useVideoConfig();
  const s = spring({ frame: frame - delay, fps, config: { damping: 16, mass: 0.7 }, durationInFrames: 24 });
  const accent = STATUS_COLOR[status];

  // running rows pulse until they resolve
  const pulse = status === 'run' ? interpolate(Math.sin((frame - delay) / 6), [-1, 1], [0.45, 1]) : 1;

  return (
    <div
      style={{
        position: 'relative',
        display: 'flex',
        alignItems: 'center',
        gap: 18,
        padding: '16px 18px',
        marginBottom: last ? 0 : 12,
        borderRadius: 14,
        background: 'rgba(255,255,255,0.025)',
        border: `1px solid ${status === 'fail' ? COLORS.red + '44' : COLORS.border}`,
        opacity: s,
        transform: `translateX(${interpolate(s, [0, 1], [-26, 0])}px)`,
      }}
    >
      {/* connector line down to next row */}
      {!last && (
        <span
          style={{
            position: 'absolute',
            left: 35,
            bottom: -13,
            width: 2,
            height: 13,
            background: COLORS.border,
          }}
        />
      )}
      {/* tool glyph */}
      <div
        style={{
          flexShrink: 0,
          width: 36,
          height: 36,
          borderRadius: 10,
          background: accent + '1A',
          border: `1px solid ${accent}40`,
          display: 'grid',
          placeItems: 'center',
        }}
      >
        <svg width={20} height={20} viewBox="0 0 24 24" fill="none" stroke={accent} strokeWidth={1.7} strokeLinecap="round" strokeLinejoin="round">
          <path d={ICONS[tool] ?? ICONS.run_terminal} />
        </svg>
      </div>
      {/* tool name + arg */}
      <div style={{ flex: 1, minWidth: 0, display: 'flex', alignItems: 'baseline', gap: 12 }}>
        <span style={{ fontFamily: FONT.mono, fontSize: 24, fontWeight: 600, color: COLORS.text }}>{tool}</span>
        <span
          style={{
            fontFamily: FONT.mono,
            fontSize: 22,
            color: COLORS.textMuted,
            whiteSpace: 'nowrap',
            overflow: 'hidden',
            textOverflow: 'ellipsis',
          }}
        >
          {arg}
        </span>
      </div>
      {/* status chip */}
      <div
        style={{
          flexShrink: 0,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 8,
          padding: '6px 14px',
          borderRadius: 99,
          background: accent + '1A',
          border: `1px solid ${accent}55`,
          opacity: pulse,
        }}
      >
        <span style={{ width: 8, height: 8, borderRadius: 99, background: accent, boxShadow: `0 0 10px ${accent}` }} />
        <span style={{ fontFamily: FONT.mono, fontSize: 20, fontWeight: 600, color: accent }}>{result}</span>
      </div>
    </div>
  );
};
