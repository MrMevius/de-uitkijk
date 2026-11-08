#!/bin/sh
# Simulated camera for mock mode: a test pattern with the camera id and wall-clock time burned in.
# Usage (from go2rtc exec): mock-camera.sh <id> <WxH> <h264|h265> <rtsp-output>
set -eu
id="$1"; size="$2"; codec="$3"; output="$4"
case "$codec" in
  h265) enc="-c:v libx265 -preset ultrafast -tune zerolatency -x265-params keyint=12:log-level=error" ;;
  *)    enc="-c:v libx264 -preset ultrafast -tune zerolatency -profile:v high -g 12" ;;
esac
# shellcheck disable=SC2086
exec ffmpeg -hide_banner -loglevel error -re -f lavfi -i "testsrc2=size=${size}:rate=6" \
  -vf "drawtext=fontfile=/usr/share/fonts/droid/DroidSans.ttf:fontsize=h/14:fontcolor=white:box=1:boxcolor=black@0.6:x=20:y=h-th-24:text='${id}  %{localtime}'" \
  -pix_fmt yuv420p $enc -an -f rtsp "$output"
