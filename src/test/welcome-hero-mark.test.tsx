
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { WelcomeHeroMark } from '@/components/chat/WelcomeHeroMark';

describe('WelcomeHeroMark', () => {
  it('renders the welcome hero mark container', () => {
    render(<WelcomeHeroMark />);

    expect(screen.getByTestId('welcome-hero-mark')).toBeInTheDocument();
  });
});
