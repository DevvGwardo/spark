import React, { useMemo } from 'react';
import { useSettingsStore } from '@/stores/settings-store';
import {
  getChatBackgroundImageStyle,
  getEffectiveChatBackgroundType,
  normalizeChatBackgroundSettings,
} from '@/lib/chat-backgrounds';
import { cn } from '@/lib/utils';

interface ChatSurfaceBackgroundProps {
  className?: string;
  testId?: string;
}

export const ChatSurfaceBackground: React.FC<ChatSurfaceBackgroundProps> = ({ className, testId }) => {
  const chatBackgroundType = useSettingsStore((state) => state.chatBackgroundType);
  const chatBackgroundImageData = useSettingsStore((state) => state.chatBackgroundImageData);
  const chatBackgroundImageFit = useSettingsStore((state) => state.chatBackgroundImageFit);
  const chatBackgroundImageOpacity = useSettingsStore((state) => state.chatBackgroundImageOpacity);

  const settings = normalizeChatBackgroundSettings({
    type: chatBackgroundType,
    imageData: chatBackgroundImageData,
    imageFit: chatBackgroundImageFit,
    imageOpacity: chatBackgroundImageOpacity,
  });
  const effectiveType = getEffectiveChatBackgroundType(settings);
  const imageStyle = useMemo(
    () =>
      settings.imageData
        ? getChatBackgroundImageStyle(settings.imageData, settings.imageFit, settings.imageOpacity)
        : undefined,
    [settings.imageData, settings.imageFit, settings.imageOpacity],
  );

  return (
    <div
      data-testid={testId}
      data-background-type={effectiveType}
      data-background-has-image={settings.imageData ? 'true' : 'false'}
      className={cn('pointer-events-none absolute inset-0 overflow-hidden', className)}
    >
      <div className="absolute inset-0 bg-[hsl(var(--background))]" />

      {effectiveType === 'solid' && (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: [
              'radial-gradient(circle at 18% 18%, hsl(var(--primary) / 0.08), transparent 0 26%)',
              'linear-gradient(180deg, hsl(var(--background)), hsl(var(--background)))',
            ].join(', '),
          }}
        />
      )}

      {effectiveType === 'gradient' && (
        <div
          className="absolute inset-0"
          style={{
            backgroundImage: [
              'radial-gradient(circle at 18% 18%, hsl(var(--primary) / 0.16), transparent 0 30%)',
              'radial-gradient(circle at 82% 0%, hsl(var(--sidebar-ring) / 0.10), transparent 0 22%)',
              'linear-gradient(160deg, hsl(var(--background)) 0%, hsl(var(--card) / 0.96) 46%, hsl(var(--sidebar-bg, 0 0% 9%)) 100%)',
            ].join(', '),
          }}
        />
      )}

      {effectiveType === 'image' && imageStyle && (
        <>
          <div className="absolute inset-0" style={imageStyle} data-background-image-fit={settings.imageFit} />
          <div
            className="absolute inset-0"
            style={{
              backgroundImage: [
                'linear-gradient(180deg, hsl(var(--background) / 0.32), hsl(var(--background) / 0.74))',
                'radial-gradient(circle at 18% 18%, hsl(var(--primary) / 0.14), transparent 0 28%)',
                'radial-gradient(circle at 82% 0%, hsl(var(--sidebar-ring) / 0.10), transparent 0 20%)',
              ].join(', '),
            }}
          />
        </>
      )}

      <div
        className="absolute inset-0 opacity-40"
        style={{
          backgroundImage:
            'linear-gradient(125deg, hsl(var(--foreground) / 0.02) 0%, transparent 24%, transparent 76%, hsl(var(--foreground) / 0.02) 100%)',
        }}
      />
      <div className="absolute inset-0 bg-[radial-gradient(circle_at_top,hsl(var(--foreground)/0.035),transparent_42%)]" />
    </div>
  );
};
