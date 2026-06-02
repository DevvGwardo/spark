# Spark showcase site

A single-file, zero-build marketing site for Spark — dark, glass-finished, bento-grid layout.

## Local preview

```bash
cd site
python3 -m http.server 4173
# open http://localhost:4173
```

## Deploy to GitHub Pages

1. Push to `main`. The workflow at `.github/workflows/pages.yml` builds and deploys the `site/` folder automatically.
2. One-time setup: **Repo → Settings → Pages → Build and deployment → Source: GitHub Actions**.

Everything is self-contained (`index.html` + `assets/`). No bundler, no dependencies — fonts load from Google Fonts, the rest is local.
