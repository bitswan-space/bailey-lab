#!/bin/sh
set -e
# Runs at IMAGE-BUILD time (deploy) via the driver's final RUN layer — NOT at
# container startup — so the deployed container serves an already-built bundle and
# starts fast. live-dev never runs this: it bind-mounts the source and hot-reloads.
#
# Produces the production bundle at /app/dist (served by entrypoint.sh outside
# live-dev). node_modules resolves via the committed symlink → /deps (installed in
# the base image); recreate it so vite reliably resolves bare imports regardless of
# how the tree was materialized.
cd /app
rm -rf node_modules
ln -sfn /deps/node_modules node_modules
cp vite.config.mjs /deps/vite.config.mjs
/deps/node_modules/.bin/vite build --config /deps/vite.config.mjs --outDir /app/dist --emptyOutDir
