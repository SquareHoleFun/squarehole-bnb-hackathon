import { ART } from '@squarehole/design';
import type { KeyboardEvent, Ref } from 'react';
import { Link } from 'react-router';
import { useDataSource } from '../features/data-source';
import { useTermsAccess } from '../features/legal';
import { ConnectWalletButton } from '../features/wallet';
import { CloseIcon, MenuIcon } from './icons';
import { SearchTrigger } from './SearchTrigger';
import { setSetupChipSlot } from './setup-chip-slot';
import { PRIMARY_NAV_ID } from './SideNav';

interface TopBarProps {
  menuOpen: boolean;
  onToggleMenu: () => void;
  onCloseMenu: () => void;
  toggleRef: Ref<HTMLButtonElement>;
}

const logo = ART.get('logo-tile');
/**
 * F166 af2: the Sepolia alpha's setup chip goes here, at the start of the bar's end (setup-chip-slot.ts). A build
 * literal: `false` in the mainnet build, so the place is not there at all.
 */
const SETUP_SLOT = import.meta.env?.SH_SEPOLIA_TRADE === true;

/**
 * Top bar: brand, the trigger for the one discovery search (the field itself lives in the feed controls), the data
 * source badge ("Local chain 31337" or "Testnet · Sepolia"; chosen in Settings; none for the sample data, F130) and the wallet
 * button (SH-015, SH-C). The launch set took the "Launch pair" button out (Launch keeps its route). The wallet button
 * only opens a wallet window when clicked; nothing prompts on load or navigation (UI-09). Before the Terms are accepted
 * (F19: only the full Terms and About & risks are reachable then), the search trigger and the wallet button are left
 * out.
 */
export function TopBar({ menuOpen, onToggleMenu, onCloseMenu, toggleRef }: TopBarProps) {
  const { id, badge } = useDataSource();
  const accepted = useTermsAccess();
  function onToggleKeyDown(event: KeyboardEvent<HTMLButtonElement>) {
    if (menuOpen && event.key === 'Escape') {
      event.preventDefault();
      onCloseMenu();
    }
  }

  return (
    <header className="sh-topbar" data-restricted={accepted ? undefined : 'true'}>
      <button
        ref={toggleRef}
        type="button"
        className="sh-topbar__menu sh-icon-button"
        aria-expanded={menuOpen}
        aria-controls={PRIMARY_NAV_ID}
        onClick={onToggleMenu}
        onKeyDown={onToggleKeyDown}
      >
        {menuOpen ? <CloseIcon /> : <MenuIcon />}
        <span className="sh-visually-hidden">Menu</span>
      </button>

      <Link to="/" className="sh-brand" aria-label="Square Hole home">
        {logo ? <img className="sh-brand__logo" src={logo.src} width={40} height={40} alt="" /> : null}
        <span className="sh-brand__text">
          <span className="sh-brand__name">Square Hole</span>
          <span className="sh-brand__tagline">Different shapes. Same hole.</span>
        </span>
      </Link>

      {accepted ? <SearchTrigger /> : null}

      <div className="sh-topbar__end">
        {SETUP_SLOT && accepted ? <span ref={setSetupChipSlot} className="sh-topbar__setup" /> : null}
        {badge.lead ? (
          <p className="sh-source-badge" data-source={id}>
            <span className="sh-source-badge__dot" aria-hidden="true" />
            <span>
              <strong>{badge.lead}</strong>
              <span className="sh-source-badge__long">{badge.rest}</span>
              <span className="sh-source-badge__short" aria-hidden="true">
                {badge.short}
              </span>
            </span>
          </p>
        ) : null}
        {accepted ? <ConnectWalletButton /> : null}
      </div>
    </header>
  );
}
