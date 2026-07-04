#!/usr/bin/env bash
# sbs-all.sh <тег> [порт] — одна команда: 3 судейских кадра (road/gravel/
# mtb) + монтажи против референсов. Делает соблюдение АБСОЛЮТНОГО правила
# sbs дешёвым: снять всё = одна строка, останется отправить 3 tg-photo с
# честными ОЖИДАЛ/ВИЖУ (sbs-guard hook не даст забыть).
set -euo pipefail
TAG="${1:?usage: sbs-all.sh <tag> [port]}"
PORT="${2:-5174}"
DIR="shots/wip/m153"
CHROME="${CHROME_BIN:-/bin/google-chrome}"
mkdir -p "$DIR"

LAAS_PORT=$PORT CHROME_BIN=$CHROME npx tsx tools/ck-shot.ts --cls asphalt      --frac 0.1  --power 210 --settle 260 --w 1600 --h 900 --out "$DIR/$TAG-road.png"
LAAS_PORT=$PORT CHROME_BIN=$CHROME npx tsx tools/ck-shot.ts --cls gravel-coarse --frac 0.15 --power 210 --settle 260 --w 1600 --h 900 --out "$DIR/$TAG-gravel.png"
LAAS_PORT=$PORT CHROME_BIN=$CHROME npx tsx tools/ck-shot.ts --cls singletrack  --frac 0.65 --power 300 --settle 260 --w 1600 --h 900 --out "$DIR/$TAG-mtb.png"

for m in road gravel mtb; do
  ref="shots/wip/what_i_want/ref-$m.jpg"
  [ "$m" = road ] && ref="shots/wip/what_i_want/ref-road-aero.jpg"
  convert "$DIR/$TAG-$m.png" -resize x1200 "/tmp/sbs-our-$m.png"
  convert "$ref" -resize x1200 "/tmp/sbs-ref-$m.png"
  montage "/tmp/sbs-our-$m.png" "/tmp/sbs-ref-$m.png" -tile 2x1 -geometry +4+0 -background '#222' "$DIR/sbs-$TAG-$m.png"
done
echo "[sbs-all] готово: $DIR/sbs-$TAG-{road,gravel,mtb}.png — Read каждый → tg-photo с ОЖИДАЛ/ВИЖУ. ПРОПУСК = ОТПИСКА."
