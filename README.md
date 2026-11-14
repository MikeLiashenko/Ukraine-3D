# Ukraine 3D

An interactive 3D map of all of Ukraine built from OpenStreetMap: every oblast, raion, city, town and village, with relief,
forests, fields, rivers, roads and every mapped building, in the browser (three.js, no server code).

- **All-Ukraine map (hub):** relief ×5, land cover, rivers and main roads, oblast and raion borders, all ~30 000 settlements.
  Pick an oblast or search for a place and open it in 3D.
- **Oblast viewer:** one page per oblast. Navigation: oblast → raion → settlement → quarters. Around the camera the city
  is built in full detail (buildings with facades and roofs, trees, cars, yards, paths) from 1.2 km tiles; further away
  there are simplified buildings, forest blobs, roads and water over 50 m relief; the whole oblast is visible as relief and land cover.
  Click a building for its address, type, floors and height; search settlements and addresses; time of day, shadows, photo mode.

Data © OpenStreetMap contributors (ODbL). Relief: AWS Terrain Tiles (terrarium; SRTM, ETOPO1 and others).

## Layout

```
scripts/ua/            the Ukraine pipeline
  ua_extract.py        one pass over ukraine-latest.osm.pbf (pyosmium) -> data_ua/bins/*.pkl, 0.2° spatial bins
  fetch_dem_ua.py      terrarium z11 relief tiles for Ukraine -> data_ua/dem11/
  ua_coast.py          the OSM coastline -> data_ua/coast.pkl (the sea is cut along it)
  ua_admin.py          oblasts, raions, hromadas, settlements, quarters -> data_ua/oblasts.json, admin_sel.pkl
  ua_region.py <slug>  one oblast -> web_ua/<slug>/: region.json, tiles + overview + addresses + 50 m relief in 12 km packs,
                       400 m relief (dem.bin.wasm), 100 m land cover (lc.png)
  ua_bundle.py <slug>  merge 2x2 packs into one file (fewer files to host)
  build_region_viewer.py <out_dir> [hub_url]   the oblast page from viewer_region_tpl.html
  ua_hub.py, build_hub.py                       the all-Ukraine map from hub_tpl.html
  ua_pubplan.py        split each oblast's files into upload batches
  build_all.sh         everything above in order
scripts/               shared with the original Kharkiv (Saltivka) viewer
  viewer_city_tpl.html, index_v4.html   viewer code the oblast page reuses (by line ranges, see @@KEEP in the template)
  gen_src.js, build_gen.py              the in-browser geometry generator (web worker) -> gen.js
web_ua/                shared runtime files: gen.js, common.json + common.bin.wasm (tree and car models), leaves.png
```

## Build

Python 3.11+ (tested with 3.13), about 15 GB of free disk and 16 GB of RAM; the full run takes about 1.5 hours.

```bash
pip install -r requirements.txt
curl -L -o data_ua/ukraine-latest.osm.pbf https://download.geofabrik.de/europe/ukraine-latest.osm.pbf
bash scripts/ua/build_all.sh
python -m http.server 8605 --directory web_ua      # then open http://localhost:8605/hub/
```

`bash scripts/ua/build_all.sh regions <slug>` rebuilds one oblast (slugs are in `data_ua/oblasts.json`: `kharkivska`,
`lvivska`, `kyiv`, `krym`, ...). After changing `scripts/gen_src.js`, run `python scripts/build_gen.py .` and copy
`web/gen.js` to `web_ua/`.

Output: about 1.2 GB for the whole country (27 regions, ~7.6 million buildings); `data_ua/` and the built `web_ua/<slug>/`
folders are not in the repository.

## Hosting

Every oblast is a static folder; any static host works. The oblast page links back to the hub with the URL given as the
second argument of `build_region_viewer.py` (default `../hub/`), and the hub links to oblasts through `data_ua/urls.json`
(`{"<slug>": "<url>"}`, default `../<slug>/`).
