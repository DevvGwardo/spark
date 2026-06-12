import { fireEvent, render, screen } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';
import { HermesEffortSlider } from '@/components/chat/HermesEffortSlider';
import { useHermesStore } from '@/stores/hermes-store';

describe('HermesEffortSlider', () => {
  beforeEach(() => {
    useHermesStore.setState({ reasoningEffort: 'medium' });
  });

  it('shows the current effort level on the toolbar button', () => {
    render(<HermesEffortSlider />);
    expect(screen.getByLabelText('Reasoning effort: Medium')).toBeInTheDocument();
  });

  it('opens the Faster/Smarter popover and updates the store from the slider', () => {
    render(<HermesEffortSlider />);
    fireEvent.click(screen.getByLabelText('Reasoning effort: Medium'));
    expect(screen.getByText('Faster')).toBeInTheDocument();
    expect(screen.getByText('Smarter')).toBeInTheDocument();

    const slider = screen.getByRole('slider', { name: 'Reasoning effort' });
    fireEvent.change(slider, { target: { value: '5' } });
    expect(useHermesStore.getState().reasoningEffort).toBe('xhigh');

    fireEvent.change(slider, { target: { value: '0' } });
    expect(useHermesStore.getState().reasoningEffort).toBe('none');
  });
});
