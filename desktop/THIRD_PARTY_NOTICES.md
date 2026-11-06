# Third-party software in Parley

Parley ships with these programs, under their own licenses.

## FFmpeg

Parley runs FFmpeg as a separate program to read audio and video files. The
copy it carries is an unmodified build from
[ffmpeg-static](https://github.com/eugeneware/ffmpeg-static) 5.3.0 (release
b6.1.1), licensed under the GNU GPL. Its license and build notes are next to it
in the app, in `server/node_modules/ffmpeg-static/`, as `ffmpeg.LICENSE` and
`ffmpeg.README`, and name who built it and where that build's source is.

FFmpeg's own source is at <https://ffmpeg.org/download.html>, and the exact
release's at <https://ffmpeg.org/releases/ffmpeg-6.1.1.tar.xz>. You may use,
change and share FFmpeg under the terms of the GPL.

## yt-dlp

Parley runs [yt-dlp](https://github.com/yt-dlp/yt-dlp) as a separate program to
fetch YouTube videos. It is released under the Unlicense, and its standalone
builds include software under other licenses, listed in that project's
`THIRD_PARTY_LICENSES.txt`.

## whisper.cpp

Parley transcribes with [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
through [@fugood/whisper.node](https://github.com/mybigday/node-whisper), both
under the MIT license. Its speech models are downloaded when first used.

## Electron

The app runs on [Electron](https://www.electronjs.org), under the MIT license.
Its license and Chromium's are next to the app as `LICENSE.electron.txt` and
`LICENSES.chromium.html`.

## qrcode-generator

Parley draws the code that opens it on your phone with
[qrcode-generator](https://github.com/kazuhikoarase/qrcode-generator), by Kazuhiko
Arase, under the MIT license.
