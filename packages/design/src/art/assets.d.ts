// Vite asset imports for this package's own typecheck (apps/web gets the same shapes from vite/client).
declare module '*.webp?no-inline' {
  const src: string;
  export default src;
}
