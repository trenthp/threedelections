# Election Map in 3D

US presidential (2020, 2024) and House midterm (2026) results by county, in 3D. Each county is a prism:

- **Footprint** = the county's land area
- **Height** = votes cast per square mile
- **Volume** = footprint × height = **votes cast**
- **Color** = margin (blue ↔ gray ↔ red)

Color options:

- **Margin**: the plain margin ramp. Its ends stop at a vivid mid tone rather than near-black, so lopsided counties
  don't carry extra visual weight just for being lopsided.
- **Weighted**: margin color whose strength follows vote density (log scale, full at 1,000 votes/sq mi). Sparse
  counties fade toward dark gray, so the color tracks where people vote rather than how much land there is.
- **Radial**: each county has a sharp-edged circle at its center covering a share of the footprint equal to
  density ÷ 300 votes/sq mi, so its **area is proportional to votes cast**. Combined with height, votes show up both
  as volume and as colored area.
- **Winner**: solid party color.

Height options: **Flat 2D** (standard map), **Votes** (votes per sq mi) or **Net margin** (the leading candidate's vote
lead per sq mi), on a **linear** (volume ∝ votes), **square-root** or **log** scale.

## Run it

```sh
npm install
npm run dev          # http://localhost:5173
npm run build        # static site in dist/ (relative paths, host anywhere)
```

`public/data/election.json` is committed, so you don't need to rebuild the data. To regenerate it from the sources:

```sh
npm run data         # downloads to data-raw/ (cached), writes public/data/election.json
```

## Deploy

The build is a static site (`dist/`) with relative paths, so it works on any static host and from any subpath.

**GitHub Pages (set up):** `.github/workflows/deploy.yml` builds and publishes on every push to `main`.
1. Create a GitHub repo and push this project to its `main` branch.
2. In the repo, go to **Settings → Pages → Build and deployment → Source** and choose **GitHub Actions**.
3. The site goes live at `https://<user>.github.io/<repo>/` after the workflow finishes.

**Elsewhere** (Netlify, Cloudflare Pages, etc.): use build command `npm run build` and output directory `dist`.

The deploy uses the committed `public/data/election.json`. To update the data, run `npm run data` locally and commit the
result.

## Data notes

- Results: [tonmcg/US_County_Level_Election_Results_08-24](https://github.com/tonmcg/US_County_Level_Election_Results_08-24).
  Shapes: U.S. Census via [us-atlas](https://github.com/topojson/us-atlas) 3.0.1. Land area is geodesic (true sq mi),
  not projected size.
- **2026 is the U.S. House midterm**: every district's votes summed by county. These are **unofficial** NYT/AP counts
  compiled by [mike10010100/elections-2026](https://github.com/mike10010100/elections-2026), pinned to a commit in
  `scripts/build-data.mjs` (`MIDTERM_COMMIT`). To refresh, bump the SHA and `MIDTERM_AS_OF`, delete
  `data-raw/2026-house.json`, and run `npm run data`. Counties still under 95% of the expected vote, and counties where
  a major party had no candidate, are flagged in the tooltip. DC has no voting House seat, so it has no 2026 result.
  That repo has no license. Vote counts are public facts, but credit the NYT/AP if you publish the site.
- **Alaska** reports by state house district, not borough, so it's drawn as one uniform statewide result.
- **Connecticut 2024** is reported by planning region. It's mapped to the legacy counties with an approximate crosswalk
  (see `scripts/build-data.mjs`).
- **DC 2024** wards are summed. **Falls Church, VA** is merged into Fairfax because it's too small for the 10m shapes.
- **2016** is omitted. The available county file is a pre-certification snapshot (e.g. CA is ~1.4M votes short).

## How it works

All ~3,100 counties are one merged mesh (~320k vertices, ~185k triangles). Each vertex carries its county id and a top/bottom flag.
Per-county color and height live in a small float texture, and the vertex shader lifts the "top" vertices. Switching
year or mode only rewrites ~3k texels and crossfades two textures, so transitions are smooth. Hover uses GPU picking:
county ids are rendered into a 1×1 target under the cursor.
