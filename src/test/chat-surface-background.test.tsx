import { act, render, screen } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ChatSurfaceBackground } from '@/components/chat/ChatSurfaceBackground';
import { useSettingsStore } from '@/stores/settings-store';

const baseSettingsState = useSettingsStore.getState();

describe('ChatSurfaceBackground', () => {
  beforeEach(() => {
    window.localStorage.clear();
  });

  afterEach(() => {
    act(() => {
      useSettingsStore.setState(baseSettingsState, true);
    });
  });

  it('renders the configured gradient background by default', () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      chatBackgroundType: 'gradient',
      chatBackgroundImageData: null,
      chatBackgroundImageFit: 'cover',
      chatBackgroundImageOpacity: 0.4,
    });

    render(<ChatSurfaceBackground testId="chat-surface-background" />);

    const surface = screen.getByTestId('chat-surface-background');
    expect(surface).toHaveAttribute('data-background-type', 'gradient');
    expect(surface).toHaveAttribute('data-background-has-image', 'false');
  });

  it('falls back to the gradient background when image mode has no uploaded image', () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      chatBackgroundType: 'image',
      chatBackgroundImageData: null,
      chatBackgroundImageFit: 'cover',
      chatBackgroundImageOpacity: 0.4,
    });

    render(<ChatSurfaceBackground testId="chat-surface-background" />);

    expect(screen.getByTestId('chat-surface-background')).toHaveAttribute('data-background-type', 'gradient');
  });

  it('renders uploaded image backgrounds with the selected fit mode', () => {
    useSettingsStore.setState({
      ...useSettingsStore.getState(),
      chatBackgroundType: 'image',
      chatBackgroundImageData: 'data:image/png;base64,abc123',
      chatBackgroundImageFit: 'tile',
      chatBackgroundImageOpacity: 0.7,
    });

    render(<ChatSurfaceBackground testId="chat-surface-background" />);

    const surface = screen.getByTestId('chat-surface-background');
    expect(surface).toHaveAttribute('data-background-type', 'image');
    expect(surface).toHaveAttribute('data-background-has-image', 'true');
    expect(surface.querySelector('[data-background-image-fit="tile"]')).not.toBeNull();
  });
});
