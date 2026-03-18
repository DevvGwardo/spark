export interface ColorTheme {
  id: string;
  name: string;
  preview: {
    bg: string;
    sidebar: string;
    accent: string;
    text: string;
  };
  variables: Record<string, string>;
}

export const COLOR_THEMES: ColorTheme[] = [
  {
    id: 'default',
    name: 'Default',
    preview: {
      bg: '#1a1a1a',
      sidebar: '#141414',
      accent: '#FF8400',
      text: '#e0e0e0',
    },
    variables: {},
  },
  {
    id: 'ayu',
    name: 'Ayu',
    preview: {
      bg: '#0B0E14',
      sidebar: '#0A0D12',
      accent: '#E6B450',
      text: '#BFBDB6',
    },
    variables: {
      'background': '220 32% 6%',
      'foreground': '40 6% 74%',
      'card': '220 28% 8%',
      'card-foreground': '40 6% 74%',
      'popover': '220 28% 8%',
      'popover-foreground': '40 6% 74%',
      'secondary': '220 20% 10%',
      'secondary-foreground': '40 6% 74%',
      'muted': '220 20% 10%',
      'muted-foreground': '40 4% 45%',
      'accent': '220 20% 10%',
      'accent-foreground': '40 6% 74%',
      'border': '220 18% 13%',
      'input': '220 18% 15%',
      'sidebar-bg': '220 32% 5%',
      'sidebar-background': '220 32% 5%',
      'sidebar-foreground': '40 6% 74%',
      'sidebar-border': '220 18% 13%',
      'sidebar-hover': '220 20% 10%',
      'sidebar-active': '220 20% 8%',
      'sidebar-accent': '220 20% 10%',
      'sidebar-accent-foreground': '40 6% 74%',
      'code-bg': '220 28% 7%',
      'frame-bg': '220 32% 5%',
    },
  },
  {
    id: 'dracula',
    name: 'Dracula',
    preview: {
      bg: '#282a36',
      sidebar: '#21222c',
      accent: '#bd93f9',
      text: '#f8f8f2',
    },
    variables: {
      'background': '231 15% 18%',
      'foreground': '60 30% 96%',
      'card': '232 14% 25%',
      'card-foreground': '60 30% 96%',
      'popover': '232 14% 25%',
      'popover-foreground': '60 30% 96%',
      'secondary': '231 15% 22%',
      'secondary-foreground': '60 30% 96%',
      'muted': '231 15% 22%',
      'muted-foreground': '228 8% 52%',
      'accent': '231 15% 22%',
      'accent-foreground': '60 30% 96%',
      'border': '231 12% 26%',
      'input': '231 12% 28%',
      'sidebar-bg': '232 16% 15%',
      'sidebar-background': '232 16% 15%',
      'sidebar-foreground': '60 30% 96%',
      'sidebar-border': '231 12% 26%',
      'sidebar-hover': '231 15% 22%',
      'sidebar-active': '231 15% 19%',
      'sidebar-accent': '231 15% 22%',
      'sidebar-accent-foreground': '60 30% 96%',
      'code-bg': '231 15% 16%',
      'frame-bg': '232 16% 14%',
    },
  },
  {
    id: 'gruvbox',
    name: 'Gruvbox',
    preview: {
      bg: '#282828',
      sidebar: '#1d2021',
      accent: '#d79921',
      text: '#ebdbb2',
    },
    variables: {
      'background': '0 0% 16%',
      'foreground': '42 33% 81%',
      'card': '20 5% 22%',
      'card-foreground': '42 33% 81%',
      'popover': '20 5% 22%',
      'popover-foreground': '42 33% 81%',
      'secondary': '20 5% 19%',
      'secondary-foreground': '42 33% 81%',
      'muted': '20 5% 19%',
      'muted-foreground': '30 6% 45%',
      'accent': '20 5% 19%',
      'accent-foreground': '42 33% 81%',
      'border': '20 5% 24%',
      'input': '20 5% 26%',
      'sidebar-bg': '195 6% 12%',
      'sidebar-background': '195 6% 12%',
      'sidebar-foreground': '42 33% 81%',
      'sidebar-border': '20 5% 24%',
      'sidebar-hover': '20 5% 19%',
      'sidebar-active': '20 5% 16%',
      'sidebar-accent': '20 5% 19%',
      'sidebar-accent-foreground': '42 33% 81%',
      'code-bg': '0 0% 14%',
      'frame-bg': '195 6% 11%',
    },
  },
  {
    id: 'intellij',
    name: 'IntelliJ',
    preview: {
      bg: '#2B2D30',
      sidebar: '#1E1F22',
      accent: '#4A88C7',
      text: '#BCBEC4',
    },
    variables: {
      'background': '225 4% 18%',
      'foreground': '224 4% 75%',
      'card': '240 4% 13%',
      'card-foreground': '224 4% 75%',
      'popover': '240 4% 13%',
      'popover-foreground': '224 4% 75%',
      'secondary': '225 4% 15%',
      'secondary-foreground': '224 4% 75%',
      'muted': '225 4% 15%',
      'muted-foreground': '220 3% 48%',
      'accent': '225 4% 15%',
      'accent-foreground': '224 4% 75%',
      'border': '225 4% 21%',
      'input': '225 4% 23%',
      'sidebar-bg': '240 4% 12%',
      'sidebar-background': '240 4% 12%',
      'sidebar-foreground': '224 4% 75%',
      'sidebar-border': '225 4% 21%',
      'sidebar-hover': '225 4% 15%',
      'sidebar-active': '225 4% 13%',
      'sidebar-accent': '225 4% 15%',
      'sidebar-accent-foreground': '224 4% 75%',
      'code-bg': '225 4% 16%',
      'frame-bg': '240 4% 11%',
    },
  },
  {
    id: 'terminal',
    name: 'Terminal',
    preview: {
      bg: '#000000',
      sidebar: '#0a0a0a',
      accent: '#00FF41',
      text: '#c0c0c0',
    },
    variables: {
      'background': '0 0% 0%',
      'foreground': '0 0% 85%',
      'card': '0 0% 7%',
      'card-foreground': '0 0% 85%',
      'popover': '0 0% 7%',
      'popover-foreground': '0 0% 85%',
      'secondary': '0 0% 8%',
      'secondary-foreground': '0 0% 85%',
      'muted': '0 0% 7%',
      'muted-foreground': '0 0% 42%',
      'accent': '0 0% 8%',
      'accent-foreground': '0 0% 85%',
      'border': '0 0% 12%',
      'input': '0 0% 14%',
      'sidebar-bg': '0 0% 4%',
      'sidebar-background': '0 0% 4%',
      'sidebar-foreground': '0 0% 85%',
      'sidebar-border': '0 0% 12%',
      'sidebar-hover': '0 0% 8%',
      'sidebar-active': '0 0% 6%',
      'sidebar-accent': '0 0% 8%',
      'sidebar-accent-foreground': '0 0% 85%',
      'code-bg': '0 0% 5%',
      'frame-bg': '0 0% 3%',
    },
  },
];

export const ACCENT_COLORS = [
  { name: 'Orange', value: '31 100% 50%' },
  { name: 'Rose', value: '346 77% 60%' },
  { name: 'Violet', value: '270 70% 65%' },
  { name: 'Blue', value: '217 91% 60%' },
  { name: 'Cyan', value: '187 85% 53%' },
  { name: 'Green', value: '152 69% 53%' },
  { name: 'Lime', value: '84 78% 55%' },
  { name: 'Yellow', value: '45 93% 58%' },
  { name: 'Amber', value: '30 90% 55%' },
  { name: 'Pink', value: '330 81% 60%' },
];

export type ColorThemeId = 'default' | 'ayu' | 'dracula' | 'gruvbox' | 'intellij' | 'terminal';

const VALID_THEME_IDS = new Set<string>(COLOR_THEMES.map((t) => t.id));

export function isColorThemeId(value: unknown): value is ColorThemeId {
  return typeof value === 'string' && VALID_THEME_IDS.has(value);
}

export function getColorTheme(id: string): ColorTheme {
  return COLOR_THEMES.find((t) => t.id === id) ?? COLOR_THEMES[0];
}
