import { useEffect, useRef } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import { COLOR_THEMES, getColorTheme } from '@/lib/themes';

/** Collect every CSS variable name used across all themes (for cleanup). */
const ALL_THEME_VAR_NAMES: string[] = (() => {
  const set = new Set<string>();
  for (const t of COLOR_THEMES) {
    for (const key of Object.keys(t.variables)) {
      set.add(key);
    }
  }
  return [...set];
})();

export function useTheme() {
  const theme = useSettingsStore((s) => s.theme);
  const setTheme = useSettingsStore((s) => s.setTheme);
  const colorTheme = useSettingsStore((s) => s.colorTheme);
  const accentColor = useSettingsStore((s) => s.accentColor);
  const prevColorThemeRef = useRef(colorTheme);

  useEffect(() => {
    const root = document.documentElement;
    const apply = (mode: 'light' | 'dark') => {
      root.classList.remove('light', 'dark');
      root.classList.add(mode);
    };

    if (theme === 'system') {
      const mq = window.matchMedia('(prefers-color-scheme: dark)');
      apply(mq.matches ? 'dark' : 'light');
      const handler = (e: MediaQueryListEvent) => apply(e.matches ? 'dark' : 'light');
      mq.addEventListener('change', handler);
      return () => mq.removeEventListener('change', handler);
    } else {
      apply(theme);
    }
  }, [theme]);

  // Apply color theme CSS variable overrides (dark themes only)
  useEffect(() => {
    const root = document.documentElement;
    const isDark =
      root.classList.contains('dark') ||
      (theme === 'system' && window.matchMedia('(prefers-color-scheme: dark)').matches);

    // Clear all theme variable overrides first
    for (const name of ALL_THEME_VAR_NAMES) {
      root.style.removeProperty(`--${name}`);
    }

    // Apply theme overrides only in dark mode and for non-default themes
    const themeData = getColorTheme(colorTheme);
    if (isDark && themeData.id !== 'default') {
      for (const [name, value] of Object.entries(themeData.variables)) {
        root.style.setProperty(`--${name}`, value);
      }
    }

    prevColorThemeRef.current = colorTheme;
  }, [colorTheme, theme]);

  // Apply accent color overrides
  useEffect(() => {
    const root = document.documentElement;
    const defaultAccent = '31 100% 50%';

    if (accentColor && accentColor !== defaultAccent) {
      root.style.setProperty('--primary', accentColor);
      root.style.setProperty('--ring', accentColor);
      root.style.setProperty('--sidebar-primary', accentColor);
      root.style.setProperty('--sidebar-ring', accentColor);
    } else {
      root.style.removeProperty('--primary');
      root.style.removeProperty('--ring');
      root.style.removeProperty('--sidebar-primary');
      root.style.removeProperty('--sidebar-ring');
    }
  }, [accentColor]);

  return { theme, setTheme };
}
