#!/usr/bin/env bash
# Whole pipeline: OSM extract of Ukraine -> one 3D viewer per oblast (web_ua/<slug>/) + the all-Ukraine hub (web_ua/hub/).
#
#   bash scripts/ua/build_all.sh                 # every step
#   bash scripts/ua/build_all.sh regions         # only rebuild the oblasts (+ hub), the extract and admin data already exist
#   bash scripts/ua/build_all.sh regions lvivska # one oblast
#
# Needs: Python 3.11+ with requirements.txt, ~15 GB free disk, data_ua/ukraine-latest.osm.pbf (Geofabrik).
set -e
HERE="$(cd "$(dirname "$0")" && pwd)"; ROOT="$(cd "$HERE/../.." && (pwd -W 2>/dev/null || pwd))"   # pwd -W: C:/... paths for Windows Python under Git Bash
export PYTHONIOENCODING=utf-8
cd "$HERE"
step="${1:-all}"

if [ "$step" = all ]; then
  python ua_extract.py "$ROOT/data_ua/ukraine-latest.osm.pbf" "$ROOT/data_ua/bins"   # one pass over the PBF -> spatial bins (~30 min)
  python fetch_dem_ua.py "$ROOT/data_ua/dem11"                                       # relief tiles (AWS Terrain Tiles, terrarium z11)
  python ua_admin.py                                                                # oblasts, raions, hromadas, settlements, quarters
fi

slugs="${2:-$(python -c "import json,sys;print(' '.join(o['slug'] for o in json.load(open(sys.argv[1],encoding='utf-8'))))" "$ROOT/data_ua/oblasts.json")}"
for s in $slugs; do
  t=$(date +%s)
  python ua_region.py "$s" > "$ROOT/data_ua/log_$s.txt" 2>&1        # tiles, packs, relief, land cover, places
  python ua_bundle.py "$s"                                          # 2x2 packs per file (fewer files to host)
  python build_region_viewer.py "$ROOT/web_ua/$s" > /dev/null      # the page (pass the hub's URL as 2nd argument when publishing)
  for f in common.json common.bin.wasm leaves.png gen.js; do cp "$ROOT/web_ua/$f" "$ROOT/web_ua/$s/"; done
  echo "$s done in $(( $(date +%s) - t ))s"
done

python ua_hub.py      # the all-Ukraine map data (reads every region.json for building counts)
python build_hub.py   # its page (oblast links from data_ua/urls.json when published, ../<slug>/ on a local server)
echo "serve it: python -m http.server 8605 --directory \"$ROOT/web_ua\"  ->  http://localhost:8605/hub/"
