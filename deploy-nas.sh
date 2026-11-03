#!/bin/sh
set -eu
cd "$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
if ! command -v docker >/dev/null 2>&1; then
    printf '%s\n' 'Docker is not available. Install/enable your NAS container manager first.'
    exit 1
fi
if docker compose version >/dev/null 2>&1; then
    docker compose build
    docker compose up -d
    docker compose ps
elif command -v docker-compose >/dev/null 2>&1; then
    docker-compose build
    docker-compose up -d
    docker-compose ps
else
    printf '%s\n' 'Docker Compose is not available.'
    exit 1
fi
