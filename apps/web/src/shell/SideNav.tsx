import { CastCharacter } from '@squarehole/design';
import type { KeyboardEvent } from 'react';
import { Link, useLocation } from 'react-router';
import { useWallet } from '../features/wallet';
import { NAV_ICONS } from './icons';
import { activeNavId, visibleNavItems } from './nav-items';

export const PRIMARY_NAV_ID = 'primary-nav';

interface SideNavProps {
  /** Compact (≤640px) menu state; the sidebar and icon rail ignore it. */
  open: boolean;
  onClose: () => void;
}

/**
 * One <nav> for every breakpoint: sidebar ≥1025px, icon rail 641–1024px, disclosure menu ≤640px. "My Box" appears only
 * once a wallet is connected; the navigation itself never asks for one (UI-09).
 */
export function SideNav({ open, onClose }: SideNavProps) {
  const { pathname, search } = useLocation();
  const wallet = useWallet();
  const account = wallet.status === 'connected' ? wallet.account : null;
  const active = activeNavId(pathname, search, account);

  function onKeyDown(event: KeyboardEvent<HTMLElement>) {
    if (open && event.key === 'Escape') {
      event.preventDefault();
      onClose();
    }
  }

  return (
    <nav id={PRIMARY_NAV_ID} className="sh-nav" aria-label="Primary" data-open={open} onKeyDown={onKeyDown}>
      <ul className="sh-nav__list">
        {visibleNavItems(account !== null).map((item) => {
          const Icon = NAV_ICONS[item.id];
          return (
            <li key={item.id}>
              <Link to={item.to} className="sh-nav__link" aria-current={active === item.id ? 'page' : undefined}>
                {Icon ? <Icon /> : null}
                <span className="sh-nav__label">{item.label}</span>
              </Link>
            </li>
          );
        })}
      </ul>
      {/* The mascot alone: no blurb to read (text diet, 2026-10-01). */}
      <div className="sh-nav__card">
        <CastCharacter id="sorter" size={72} caption={false} />
      </div>
    </nav>
  );
}
