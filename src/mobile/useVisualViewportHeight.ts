import { useEffect, useState } from 'react';

/**
 * Tracks the visual viewport height so fixed-height mobile layouts shrink
 * when the on-screen keyboard opens (iOS Safari does not resize the layout
 * viewport for the keyboard). Returns null until measured — callers should
 * fall back to 100dvh.
 */
export function useVisualViewportHeight(): number | null {
  const [height, setHeight] = useState<number | null>(() =>
    typeof window !== 'undefined' && window.visualViewport
      ? window.visualViewport.height
      : null,
  );

  useEffect(() => {
    const vv = window.visualViewport;
    if (!vv) return;
    const update = () => setHeight(vv.height);
    vv.addEventListener('resize', update);
    vv.addEventListener('scroll', update);
    update();
    return () => {
      vv.removeEventListener('resize', update);
      vv.removeEventListener('scroll', update);
    };
  }, []);

  return height;
}
