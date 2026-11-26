/**
 * `/box/:chain/:address`: the SPA's index.html with the box's link-preview tags (Open Graph, Twitter, canonical), so a
 * shared box link unfurls with its name, its state and its card, drawn by the card service on the droplet
 * (src/share/share-edge.ts, packages/cards). The page itself is the same app; only the head differs.
 */
import { handleBoxPage, type ShareContext } from '../../../src/share/share-edge';

export const onRequestGet = (context: ShareContext): Promise<Response> => handleBoxPage(context);
export const onRequestHead = onRequestGet;
