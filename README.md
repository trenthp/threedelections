# Election Map in 3D

US presidential (2004–2024) and House (2004–2026) results by county, in 3D. Each county is a prism:

- **Footprint** = the county's land area
- **Height** = votes cast per square mile
- **Volume** = footprint × height = **votes cast**
- **Circle** (the default color mode) = a disc on each county whose area is proportional to votes cast, colored by
  margin (blue ↔ gray ↔ red). The rest of the county is dark gray, so the amount of color matches the number of voters.

The intro text and the small-screen header describe whatever combination is on screen (`readingGuide()` in
`src/main.js`), so a shared link with other settings is still explained correctly.

Color options:

- **Margin**: the plain margin ramp. Its ends stop at a vivid mid tone rather than near-black, so lopsided counties
  don't carry extra visual weight just for being lopsided.
- **Weighted**: margin color whose strength follows vote density (log scale, full at 1,000 votes/sq mi). Sparse
  counties fade toward dark gray, so the color tracks where people vote rather than how much land there is.
- **Radial** (default): each county has a sharp-edged circle at its center covering a share of the footprint equal to
  density ÷ 300 votes/sq mi, so its **area is proportional to votes cast**. Combined with height, votes show up both
  as volume and as colored area.
- **Winner**: solid party color.

Height options: **Flat 2D** (standard map), **Votes** (votes per sq mi) or **Net margin** (the leading candidate's vote
lead per sq mi), on a **linear** (volume ∝ votes), **square-root** or **log** scale.

Pick **President** or **House** and a year from the bar under the map (←/→ step through years, ↑/↓ switch race).
Years without that race stay on the timeline, dimmed; clicking one switches race. Click or tap a county to pin it: its
details stay on screen while you switch elections, with a chart of its margin in every election (solid dots presidential,
hollow dots House; click a dot to jump there) and the shift since the previous race of the same kind. On small screens
the panel becomes a bottom sheet with the year bar on top, a header across the top of the screen names the
election and summarizes what height and color mean (**?** opens the full explanation), and the pinned county takes over
the sheet. Drag the sheet's grip (or tap it) to switch between collapsed, half and full height. On short landscape
screens (phones held sideways) the sheet is a column on the left instead.

**Find a county** searches by name, optionally with a state or its abbreviation (`cook il`, `washington pa`); matches
are ranked by votes cast, and picking one pins it and flies the camera there. Press `/` to jump to the search box. Once
the camera leaves a preset, a **Reset view** button brings it back.

The URL hash mirrors what's on screen, so any view can be shared: e.g. `#y=2020&c=04013&col=margin&v=top` opens 2020
with Maricopa County pinned, margin colors and the top-down camera. Keys: `y` year, `r=house` for the House race in a
presidential year (a year with only a House race needs no `r`), `c` pinned county FIPS, `h`
height (`flat`/`votes`/`net`), `s` scale (`linear`/`sqrt`/`log`), `col` color, `x` exaggeration, `v` camera preset or
`cam` (camera x,y,z and target x,y,z). Settings at their default are left out. The pinned card has a Copy link button.

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

## Link previews

`index.html` has Open Graph and Twitter tags pointing at `https://trenthp.github.io/threedelections/og.png`
(`public/og.png`, 1200×630). Scrapers need an absolute URL, so update `og:image` if the site moves. The image is a
render of the default 2024 view with the panel hidden and the title drawn in Rubik; regenerate it by hand if the map's
look changes.

## Data notes

Elections are keyed by id (`p2024` presidential, `h2022` House) in `election.json`, since presidential years also have
House races.

- **2020 and 2024 presidential**: [tonmcg/US_County_Level_Election_Results_08-24](https://github.com/tonmcg/US_County_Level_Election_Results_08-24).
  Shapes: U.S. Census via [us-atlas](https://github.com/topojson/us-atlas) 3.0.1. Land area is geodesic (true sq mi),
  not projected size.
- **2004–2016 presidential and 2004–2026 House**: NYT/AP counts compiled by
  [mike10010100/elections-2026](https://github.com/mike10010100/elections-2026), one file with keys `p04`…`p16` and
  `h04`…`h26`, pinned to a commit in `scripts/build-data.mjs` (`MIDTERM_COMMIT`). House results sum every district's
  votes by county. 2026 is **unofficial**: to refresh, bump the SHA and `MIDTERM_AS_OF`, delete
  `data-raw/2026-house.json`, and run `npm run data`. Counties still under 95% of the expected vote, and counties where
  a major party had no candidate, are flagged in the tooltip. That repo has no license. Vote counts are public facts,
  but credit the NYT/AP if you publish the site.
- **Hawaii and DC**: the multi-year file has no Hawaii or DC presidential rows. Hawaii 2008–2016 and DC 2008 come from
  tonmcg's 2008–2016 file (Hawaii within ~1% of certified totals); its DC 2012/2016 rows are well short of certified
  totals, so they're left out. No Hawaii results for 2004, no DC for 2004/2012/2016, and no Hawaii House results before
  2024. DC has no voting House seat.
- **Uncontested House seats**: some states (FL, OK, AR, LA, ...) leave unopposed races off the ballot, so counties wholly
  in such a district report no House votes that year. They're flagged so the UI can explain.
- **Alaska** reports by state house district, not borough, so it's drawn as one uniform statewide result. Its 2022
  House count is the first round of ranked-choice voting.
- **Connecticut 2024 presidential** is reported by planning region. It's mapped to the legacy counties with an
  approximate crosswalk (see `scripts/build-data.mjs`).
- **DC 2024** wards are summed. **Falls Church, VA** is merged into Fairfax because it's too small for the 10m shapes,
  and **Bedford city, VA** (until 2013) into Bedford County. **Shannon County, SD** is mapped to its new code (Oglala
  Lakota).
- tonmcg's own 2016 file is a pre-certification snapshot (e.g. CA is ~1.4M votes short), so 2016 uses the multi-year file.

## How it works

All ~3,100 counties are one merged mesh (~320k vertices, ~185k triangles). Each vertex carries its county id and a top/bottom flag.
Per-county color and height live in a small float texture, and the vertex shader lifts the "top" vertices. Switching
election or mode only rewrites ~3k texels and crossfades two textures, so transitions are smooth. Hover uses GPU picking:
county ids are rendered into a 1×1 target under the cursor.
