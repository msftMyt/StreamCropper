# StreamCropper

BetterDiscord plugin that crops ultrawide (`21:9`, `32:9`) and multi-monitor Discord screen shares at the WebRTC `MediaStream` source level.

**Download:** [`StreamCropper.plugin.js`](https://raw.githubusercontent.com/msftMyt/StreamCropper/main/StreamCropper.plugin.js)

## Why it works differently

CSS-based stream croppers (`clip-path` + `transform: scale()`) leave massive black bars on 32:9 ultrawide streams because Discord sizes its player stage, letterbox wrapper, and zoom bounds directly from `video.videoWidth` and `video.videoHeight`. Even if you clip the `<video>` visually, Discord still thinks it is rendering a `5120×1440` feed and clamps it inside a short horizontal strip. StreamCropper intercepts the live WebRTC video track via Chromium's WebCodecs `MediaStreamTrackProcessor` and `VideoFrame` `visibleRect` (with a `canvas.captureStream()` fallback) to hand Discord a real `2560×1440` `MediaStream` while passing original audio tracks through untouched. Because Discord receives genuine cropped source dimensions, native stage layout, Popout windows, Fullscreen, the floating PiP mini-player, and Discord's built-in zoom/pan all work out of the box.

## Controls & Features

| Control / Feature | Behavior |
| --- | --- |
| **Quick Slices (`Left` / `Center` / `Right` / `21:9` / `Full`)** | Carves out a standard `16:9` (or configured aspect) monitor slice from ultrawide feeds in one click, or restores the uncropped stream. |
| **Live Full-Frame Minimap** | Previews the entire uncropped desktop even while watching a cropped region. Drag to pan, drag handles to resize, scroll or press `+`/`-` to zoom, use Arrow keys (`Shift` + Arrow for larger steps) to nudge, or double-click / press `0` to reset. |
| **`Draw Custom Region` Modal** | Opens a large live view of the uncropped source so you can drag a box around a specific window or game viewport (`Esc` cancels without exiting Fullscreen). |
| **Per-Streamer Crop Memory** | Remembers your last crop per streamer and resolution, restoring it automatically when switching between call streams, channels, Popout, or remounted players. |
| **Popout, Fullscreen & Floating PiP Support** | Tracks streams across Discord's Popout windows, Fullscreen Top Layer transitions, and compact floating PiP mini-players without interrupting playback. |
| **Saved Presets** | Bookmark up to 6 custom crop regions inside the HUD for one-click recall across streams. |

## Install

1. Download [`StreamCropper.plugin.js`](https://raw.githubusercontent.com/msftMyt/StreamCropper/main/StreamCropper.plugin.js).
2. In Discord, open **User Settings -> BetterDiscord -> Plugins -> Open Plugins Folder**.
3. Move `StreamCropper.plugin.js` into the `plugins` folder and toggle **StreamCropper** on.

## Settings

Configured under **User Settings -> BetterDiscord -> Plugins -> StreamCropper**:

- **Overlay Button Position** — Place the hover `Crop` pill in the `Top Right` (default) or `Top Left` corner of the stream stage.
- **Left / Center / Right Target Aspect Ratio** — Target slice aspect carved out on ultrawide streams (`16:9`, `21:9`, or `4:3`).
- **Remember Crop Per Streamer** — Automatically restore your last crop when returning to the same streamer.
- **Auto-Center Ultrawide Streams (21:9 / 32:9)** — Start new ultrawide screen shares in a `Center` crop automatically.
- **Show Cropped Resolution on Pill** — Display active output dimensions (e.g. `2560×1440`) on the player `Crop` pill.

## Testing

```bash
node --test test.mjs
```

## License

[MIT](./LICENSE)
