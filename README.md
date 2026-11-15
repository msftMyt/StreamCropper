# StreamCropper

BetterDiscord plugin for cropping ultrawide (`21:9`, `32:9`) and multi-monitor Discord screen shares at the **`MediaStream` source level**.

Most stream-cropping snippets try to apply CSS `clip-path` and `transform: scale()` directly to Discord's `<video>` element. That breaks on ultrawide streams because Discord sizes its player layout around `video.videoWidth` and `video.videoHeight`, clamping the stream inside a short 32:9 wrapper box surrounded by black bars.

**StreamCropper** crops the WebRTC video track itself (`MediaStreamTrackProcessor` + `VideoFrame` `visibleRect` + `MediaStreamTrackGenerator`, with a `canvas.captureStream()` fallback) and hands Discord a stream with the cropped pixel dimensions. Discord sees a normal 16:9 (or custom-sized) stream and handles stage sizing, popout windows, fullscreen, and its built-in zoom/pan controls natively.

## Features

- **Real `MediaStream` cropping** — zero CSS transform hacks on Discord's `<video>`, keeping original stream audio untouched.
- **Quick monitor slices** — one-click **Left**, **Center**, **Right**, **21:9**, and **Full** presets.
- **Live full-frame minimap & custom region modal** — drag or resize the crop box on a live preview of the uncropped desktop even while watching the cropped feed, or open **Draw Custom Region** to drag a box around a specific window.
- **Remembers crops per streamer** — if you click onto another call member's stream or text channel and click back, your previous crop for that streamer is restored automatically.
- **Saved presets & native BD settings** — save favorite crops for one-click recall and configure defaults under **Settings → BetterDiscord → Plugins → StreamCropper**.

## Installation

1. Download [`StreamCropper.plugin.js`](./StreamCropper.plugin.js).
2. In Discord, open **User Settings → BetterDiscord → Plugins → Open Plugins Folder**.
3. Drop `StreamCropper.plugin.js` into the `plugins` folder and enable **StreamCropper**.

## Usage

1. Hover over an active screen share and click **`Crop`** in the top-right corner of the player.
2. Pick **`Left`**, **`Center`**, or **`Right`**, drag the box inside the minimap, or click **`Draw Custom Region`** to select a specific window.
3. Click **`Reset`** (or double-click the minimap) to go back to the full uncropped stream.

## Running Tests

```bash
node --test test.mjs
```

## License

[MIT](./LICENSE)
