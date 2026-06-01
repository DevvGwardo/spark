import { AbsoluteFill, Img, interpolate, spring, staticFile, useCurrentFrame, useVideoConfig } from 'remotion';
import { COLORS } from '../theme';

type Props = {
  src: string;
  width: number;
  delay?: number;
  // Ken Burns: subtle scale + pan over the life of the scene
  zoom?: [number, number];
  panX?: [number, number];
  panY?: [number, number];
  chrome?: boolean;
  label?: string;
};

// Frames a screenshot in a rounded, shadowed card with optional macOS-style chrome
// and a slow Ken-Burns move. object-fit: contain so no capture gets cropped.
export const DeviceFrame: React.FC<Props> = ({
  src,
  width,
  delay = 0,
  zoom = [1, 1],
  panX = [0, 0],
  panY = [0, 0],
  chrome = true,
  label,
}) => {
  const frame = useCurrentFrame();
  const { fps, durationInFrames } = useVideoConfig();
  const f = frame - delay;

  const enter = spring({ frame: f, fps, config: { damping: 18, mass: 0.9 }, durationInFrames: 34 });
  const t = interpolate(frame, [0, durationInFrames], [0, 1], { extrapolateRight: 'clamp' });
  const scale = interpolate(t, [0, 1], zoom) * interpolate(enter, [0, 1], [0.92, 1]);
  const tx = interpolate(t, [0, 1], panX);
  const ty = interpolate(t, [0, 1], panY);
  const opacity = interpolate(enter, [0, 1], [0, 1]);
  const lift = interpolate(enter, [0, 1], [40, 0]);

  return (
    <div
      style={{
        width,
        borderRadius: 22,
        background: COLORS.bgPlate,
        border: `1px solid ${COLORS.borderStrong}`,
        boxShadow: '0 40px 120px rgba(0,0,0,0.65), 0 0 0 1px rgba(255,255,255,0.03) inset',
        overflow: 'hidden',
        opacity,
        transform: `translateY(${lift}px)`,
      }}
    >
      {chrome && (
        <div
          style={{
            height: 38,
            display: 'flex',
            alignItems: 'center',
            gap: 8,
            padding: '0 16px',
            background: 'rgba(255,255,255,0.03)',
            borderBottom: `1px solid ${COLORS.border}`,
          }}
        >
          <span style={{ width: 11, height: 11, borderRadius: 99, background: '#FF5F57' }} />
          <span style={{ width: 11, height: 11, borderRadius: 99, background: '#FEBC2E' }} />
          <span style={{ width: 11, height: 11, borderRadius: 99, background: '#28C840' }} />
          {label && (
            <span style={{ marginLeft: 14, fontSize: 15, color: COLORS.textFaint, letterSpacing: 0.3 }}>{label}</span>
          )}
        </div>
      )}
      <div style={{ position: 'relative', overflow: 'hidden' }}>
        <AbsoluteFill style={{ background: COLORS.bg }} />
        <Img
          src={staticFile(src)}
          style={{
            display: 'block',
            width: '100%',
            objectFit: 'contain',
            transform: `scale(${scale}) translate(${tx}px, ${ty}px)`,
            transformOrigin: 'center center',
          }}
        />
      </div>
    </div>
  );
};
