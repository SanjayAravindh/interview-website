# Interview Notes

Browse markdown notes in a left sidebar and render them as HTML. Notes under `notes/` (including subfolders like `notes/Java/`) are listed automatically.

## Run locally

```bash
node server.js
```

Open http://localhost:3000

## Add a note

Drop a `.md` file into `notes/` or a subfolder, then refresh. The sidebar groups notes by folder.

## Deploy (GitHub Pages)

1. Push this repo to GitHub.
2. In the repo: **Settings → Pages → Build and deployment → Source: GitHub Actions**.
3. The workflow in `.github/workflows/pages.yml` builds `dist/` and publishes it.

After each push to `main`, new notes appear on the hosted site.

```bash
npm run build
```

writes `notes.json` and a static `dist/` folder you can host anywhere (Netlify, Cloudflare Pages, etc.).
