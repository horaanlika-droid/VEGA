#!/usr/bin/env bash
# ============================================================
# build-ambience.sh — воспроизводимая сборка звуковых подложек
# ------------------------------------------------------------
# Делает всё с нуля: качает открытые записи (CC0), приводит их к
# одному виду, собирает бесшовные петли и кодирует в .m4a.
#
# Требуется: bash, node >= 18, git, gh (авторизованный) или curl,
#            ffmpeg (если нет — скрипт поставит его из npm).
#
# Запуск:  bash tools/build-ambience.sh
# Итог:    assets/*.m4a + отчёт work/out/report.json
# ============================================================
set -euo pipefail
cd "$(dirname "$0")/.."
ROOT=$(pwd)
WORK="$ROOT/work"
mkdir -p "$WORK/raw" "$WORK/out" assets

say() { printf '\n\033[1;36m%s\033[0m\n' "$1"; }

# ---------- 1. инструменты ----------
say "1/5 инструменты"
command -v node >/dev/null || { echo "нужен node >= 18"; exit 1; }
command -v git  >/dev/null || { echo "нужен git"; exit 1; }

FF=$(command -v ffmpeg || true)
if [ -z "$FF" ]; then
  if [ -x "$ROOT/.tools/node_modules/@ffmpeg-installer/linux-x64/ffmpeg" ]; then
    FF="$ROOT/.tools/node_modules/@ffmpeg-installer/linux-x64/ffmpeg"
  else
    echo "ffmpeg не найден — ставлю из npm (без сети не выйдет)"
    mkdir -p "$ROOT/.tools" && cd "$ROOT/.tools"
    npm init -y >/dev/null 2>&1 || true
    npm i @ffmpeg-installer/ffmpeg --no-audit --no-fund >/dev/null 2>&1 || true
    cd "$ROOT"
    FF="$ROOT/.tools/node_modules/@ffmpeg-installer/linux-x64/ffmpeg"
  fi
fi
echo "ffmpeg: $FF"

# ---------- 2. исходные записи (CC0) ----------
say "2/5 открытые записи (CC0 1.0)"
SRC="$WORK/src"
if [ ! -d "$SRC/Coolhead-Ambience" ]; then
  echo "· клонирую Coolhead-Ambience (полевые записи: лес, дождь, река, волны, колокольчики)"
  git clone --depth 1 -q https://github.com/biomathcode/Coolhead-Ambience.git "$SRC/Coolhead-Ambience"
fi
# игра: короткие петли костра из Free-SFX (тоже CC0).
# raw.githubusercontent.com в песочнице недоступен — берём через GitHub API.
R=EternityForest/Free-SFX
get_blob() { # $1 путь в репозитории, $2 куда
  local p="$1" out="$2"
  if [ -f "$out" ]; then echo "· уже есть: $(basename "$out")"; return; fi
  local sha
  sha=$(gh api "repos/$R/git/trees/HEAD?recursive=1" --jq ".tree[]|select(.path==\"$p\")|.sha")
  gh api "repos/$R/git/blobs/$sha" --jq '.content' | tr -d '\n' | base64 -d > "$out"
  echo "· скачано: $(basename "$out") ($(du -h "$out" | cut -f1))"
}
mkdir -p "$SRC/freesfx"
get_blob "PagDev/fire_loop.opus" "$SRC/freesfx/fire_loop.opus"

# ---------- 3. приведение к одному виду ----------
say "3/5 приведение дорожек к 48 кГц / моно / float32"
dec() { # $1 вход, $2 выход, $3 фильтры
  "$FF" -v error -y -i "$1" -af "${3:-anull}" -ac 1 -ar 48000 -f f32le "$WORK/raw/$2"
  printf '· %-14s <- %s\n' "$2" "$(basename "$1")"
}
dec "$SRC/Coolhead-Ambience/WaveLight1.wav"       sea.f32     "highpass=f=45"
dec "$SRC/Coolhead-Ambience/RainDripping1.wav"    rain.f32    "highpass=f=80"
dec "$SRC/Coolhead-Ambience/Forest1.wav"          forest.f32  "highpass=f=90"
dec "$SRC/Coolhead-Ambience/BirdsChirping1.wav"   birds.f32   "highpass=f=250,volume=-7dB"
dec "$SRC/freesfx/fire_loop.opus"                 fire.f32    ""
dec "$SRC/Coolhead-Ambience/VinylCrackle1.wav"    crackle.f32 "highpass=f=400"
dec "$SRC/Coolhead-Ambience/RiverLight1.wav"      river.f32   "lowpass=f=560,highpass=f=50"
dec "$SRC/Coolhead-Ambience/WaterfallStream1.wav" shimmer.f32 "highpass=f=3000,lowpass=f=9500"

# ---------- 4. петли ----------
say "4/5 бесшовные петли (кроссфейд + нормировка по RMS)"
node tools/loopify.mjs tools/recipes.json "$WORK/out"

# ---------- 5. кодирование ----------
say "5/5 кодирование в AAC (m4a)"
for n in sea rain hearth forest lullaby space; do
  "$FF" -v error -y -f f32le -ar 48000 -ac 1 -i "$WORK/out/$n.f32" \
    -c:a aac -b:a 80k -profile:a aac_low -movflags +faststart "assets/$n.m4a"
done
# настоящие колокольчики — редкие акценты поверх музыки
"$FF" -v error -y -i "$SRC/Coolhead-Ambience/Windchimes1.wav" -af "highpass=f=200,volume=-4dB" \
  -ac 1 -ar 48000 -c:a aac -b:a 80k -movflags +faststart assets/chimes.m4a

printf '\nИтог:\n'
ls -la assets | awk 'NR>3 {printf "  %7.0f КБ  %s\n", $5/1024, $9}'
echo
echo "Проверка громкости (интегрированная, LUFS):"
for f in assets/*.m4a; do
  printf '  %-14s ' "$(basename "$f")"
  "$FF" -hide_banner -nostats -i "$f" -filter_complex ebur128 -f null - 2>&1 \
    | grep -E "^\s+I:" | tail -1 | tr -s ' '
done
