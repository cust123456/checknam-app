# High-Speed Archive Checker

Ultra-fast tool to check if domains have snapshots on the Internet Archive (Wayback Machine).
- Paste any text/URLs/emails → input auto-cleans to **unique valid domains only**.
- Concurrency slider for parallel checks.
- Progress bar and CSV export.

## Stack
- Vite + React 18
- Tailwind CSS
- framer-motion
- lucide-react

## Getting Started
```bash
npm i
npm run dev
```

Build:
```bash
npm run build
npm run preview
```

## Deploy (Vercel)
- Import this repo on Vercel.
- Framework preset: **Vite** (Build Command: `vite build`, Output: `dist/`).

## Notes
- Uses the public Wayback "available" endpoint.
- Input area automatically keeps only domains (e.g., `https://foo.com/x` → `foo.com`, `user@bar.co` → `bar.co`), removes duplicates, strips `www.` and trailing dots.
