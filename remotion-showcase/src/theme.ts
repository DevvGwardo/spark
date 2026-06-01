// Spark brand tokens — mirrored from the app (src/index.css, tailwind config).
export const COLORS = {
  // Surfaces (dark-native)
  bg: '#0B0D12',
  bgPlate: '#11141B',
  bgRaised: '#14171F',
  card: '#171B24',
  border: 'rgba(255,255,255,0.08)',
  borderStrong: 'rgba(255,255,255,0.14)',

  // Text
  text: '#F4F6FA',
  textMuted: 'rgba(244,246,250,0.55)',
  textFaint: 'rgba(244,246,250,0.32)',

  // Brand — Spark orange
  primary: '#FF8F3F',
  primaryGlow: '#FFB86B',
  primaryDeep: '#FF5A36',
  primarySoft: '#FFD36B',

  // Accents used across Hermes panels
  cyan: '#59D4FF',
  mint: '#8FFFC1',
  green: '#00D875',
  red: '#EF4444',
};

// Gradients pulled straight from the Hermes Usage panel.
export const GRADIENTS = {
  token: 'linear-gradient(90deg, #59d4ff 0%, #8fffc1 100%)',
  activity: 'linear-gradient(180deg, #ffb86b 0%, #ff8f3f 100%)',
  spark: 'linear-gradient(135deg, #FFF4C7 0%, #FFD36B 55%, #FFAA3B 100%)',
  ring: 'linear-gradient(135deg, #FFCF70 0%, #FF8B2B 50%, #FF5A36 100%)',
  plate: 'linear-gradient(135deg, #1A1D24 0%, #11141B 55%, #0B0D12 100%)',
};

export const FONT = {
  sans: 'Geist, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif',
  mono: '"Geist Mono", ui-monospace, SFMono-Regular, Menlo, monospace',
};

export const FPS = 30;

// Scene boundaries in frames (30fps) — total 1350 frames = 45s.
export const SCENES = {
  intro: { start: 0, dur: 150 },
  overview: { start: 150, dur: 270 },
  usage: { start: 420, dur: 240 },
  charts: { start: 660, dur: 210 },
  chats: { start: 870, dur: 300 },
  outro: { start: 1170, dur: 180 },
};

export const TOTAL_FRAMES = 1350;

// Voiceover placement (frame each VO segment starts at).
export const VO = [
  { src: 'audio/01_intro.mp3', at: 24 },
  { src: 'audio/02_overview.mp3', at: 168 },
  { src: 'audio/03_usage.mp3', at: 438 },
  { src: 'audio/04_charts.mp3', at: 678 },
  { src: 'audio/05_chats.mp3', at: 888 },
  { src: 'audio/06_outro.mp3', at: 1188 },
];
