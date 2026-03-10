import { useEffect } from 'react';
import { useSettingsStore, type FontSize, type FontFamily } from '@/stores/settings-store';

const FONT_SIZE_MAP: Record<FontSize, string> = {
  small: '14px',
  medium: '16px',
  large: '18px',
};

const FONT_BODY_CLASS: Record<FontFamily, string | null> = {
  inter: null,        // default — no extra class needed
  mono: 'font-mono-ui',
  serif: 'font-serif-ui',
};

export function useGlobalStyles() {
  const fontSize = useSettingsStore((s) => s.fontSize);
  const fontFamily = useSettingsStore((s) => s.fontFamily);

  useEffect(() => {
    document.documentElement.style.fontSize = FONT_SIZE_MAP[fontSize];
  }, [fontSize]);

  useEffect(() => {
    // Remove all font classes first
    document.body.classList.remove('font-mono-ui', 'font-serif-ui');

    const cls = FONT_BODY_CLASS[fontFamily];
    if (cls) {
      document.body.classList.add(cls);
    }
  }, [fontFamily]);
}
