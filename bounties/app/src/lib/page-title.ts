import { useEffect } from 'react';
import type { Route } from '../App';

export function usePageTitle(screen: Route['name'] | null, detail?: string) {
  useEffect(() => {
    if (screen === null) return;
    let name = 'Launches';
    switch (screen) {
      case 'flap-create': name = 'Launch on Flap'; break;
      case 'four-create': name = 'Launch on Four.meme'; break;
      case 'pile': name = 'Pile'; break;
      case 'unknown': name = 'Not found'; break;
      case 'flap-sale':
      case 'four-token': name = detail || 'Launches'; break;
      case 'shop': name = detail ? `${detail} cards` : 'Launches'; break;
    }
    document.title = `${name} · Square Hole`;
  }, [screen, detail]);
}
