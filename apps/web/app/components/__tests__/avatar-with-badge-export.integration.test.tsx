import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';

import { AvatarWithBadge } from '@/components';
import type { AvatarWithBadgeProps } from '@/components';

describe('AvatarWithBadge component export contract', () => {
  it('imports the named component and props type from @/components', () => {
    const props: AvatarWithBadgeProps = {
      handle: 'exported',
      mode: 'script_verified',
      size: 'small',
    };
    const markup = renderToStaticMarkup(<AvatarWithBadge {...props} />);

    expect(typeof AvatarWithBadge).toBe('function');
    expect(markup).toContain('data-testid="avatar-with-badge"');
    expect(markup).toContain('Verified via script');
  });
});
