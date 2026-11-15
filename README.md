# StreamCropper

A BetterDiscord plugin that crops ultrawide (`21:9`, `32:9`) and multi-monitor Discord screen shares at the **`MediaStream` source level** so Discord natively handles layout, aspect-ratio sizing, fullscreen, popout windows, and built-in zoom/pan as if the streamer were sharing a standard monitor.

---

## Features

- **True `MediaStream` Source Cropping:** Uses Chromium's hardware-accelerated WebCodecs pipeline (`MediaStreamTrackProcessor` + `VideoFrame` `visibleRect` + `MediaStreamTrackGenerator`, with a `<canvas>.captureStream()` fallback) to replace `<video>.srcObject` with a real cropped stream while keeping original stream audio untouched.
- **Native Discord Player Behavior:** Because Discord receives a stream with the cropped pixel dimensions (for example, `2560×1440` extracted from `5120×1440`), Discord's own stage sizing, popout player, fullscreen mode, and native zoom/pan controls work out of the box with zero CSS transform hacks.
- **1-Click Ultrawide Presets:** Quickly slice an ultrawide screen into **Left**, **Center**, **Right**, **21:9**, or **Full**.
- **Live Full-Source Minimap & Custom Draw Modal:**
  - Drag or resize the selection box inside the live full-frame minimap even while watching the cropped stream.
  - Open **Draw Custom Region** to drag a pixel-accurate box around any specific window or game on the streamer's desktop.
- **Automatic Per-Streamer Memory:** Clicking off someone's stream (or switching between an ultrawide streamer and a 16:9 streamer) and clicking back automatically restores your last crop for that streamer.
- **Saved Presets & Native Settings:** Save named crop presets for one-click recall and customize plugin behavior through BetterDiscord's plugin settings panel (`BdApi.UI.buildSettingsPanel`).

---

## Installation

1. Download [`StreamCropper.plugin.js`](./StreamCropper.plugin.js).
2. Open Discord and go to **User Settings → BetterDiscord → Plugins**.
3. Click **Open Plugins Folder** and place `StreamCropper.plugin.js` inside it.
4. Toggle **StreamCropper** on in your Plugins list.

---

## Usage

1. Hover over any active screen share in Discord and click the **`Crop`** button in the top-right corner of the stream player.
2. Select **`Left`**, **`Center`**, or **`Right`** to extract a clean `16:9` monitor slice, drag the box inside the minimap, or click **`Draw Custom Region`** to select a custom area.
3. Click **`Reset`** (or double-click the minimap) at any time to return to the full uncropped stream.

---

## Development & Tests

Run the zero-dependency Node test suite (`node >= 18`):

```bash
node --test test.mjs
```

---

## License

[MIT](./LICENSE)
