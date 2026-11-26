import { cleanup, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it } from 'vitest';
import { Metric } from './pair-parts';

afterEach(cleanup);

describe('Metric (FEED-06)', () => {
  it('an unavailable value is a decorative dash plus visually hidden words, not an image', () => {
    const { container } = render(<Metric value={null} />);
    expect(screen.queryByRole('img')).toBeNull();
    const dash = container.querySelector('[aria-hidden="true"]');
    expect(dash?.textContent).toBe('—');
    expect(screen.getByText('Not available').className).toBe('sh-visually-hidden');
    expect(container.textContent).not.toContain('$0');
  });

  it('an available value renders as is', () => {
    render(<Metric value="$84.2K" />);
    expect(screen.getByText('$84.2K').className).toBe('sh-numeric');
  });
});
