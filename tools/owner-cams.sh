#!/usr/bin/env bash
# Owner repro cams (mandatory water-change gate, session 6, 2026-07-03).
# The three Shift+D --cam poses from the owner's shots/wip/hueta/ screenshots
# that documented the M1.4.2 water disaster (sawtooth walls, slope sheets,
# water piled over the road). Re-shoot after EVERY water-related change and
# LOOK at each frame; send all three to the Telegram bot with honest captions.
# Note: waterY feeds RoadNetwork routing — road layout at these poses shifts
# whenever water changes. Judge WATER behavior, not frame-for-frame identity.
#
# Usage: tools/owner-cams.sh [prefix]   (default prefix: owner-cams)
# Output: shots/wip/<prefix>-cam{1,2,3}.png   Needs dev server on :5173.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PREFIX="${1:-owner-cams}"
shoot() {
  npx tsx tools/shoot.ts --scene world --seed 1 --T 11 --preset high \
    --cam "$1" --out "shots/wip/${PREFIX}-$2.png"
}
shoot "-72.3,280.5,-39.4,0.25,0.01,55"  cam1   # gully: sawtooth wall / bubble dome
shoot "-84.6,274.7,-36.7,2.68,0.02,55"  cam2   # slope: draped sheet / cut-bank curtains
shoot "-104.2,275.1,-15.9,3.57,0.05,55" cam3   # road: raised water pile across it
echo "done: shots/wip/${PREFIX}-cam{1,2,3}.png"
