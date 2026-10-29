# README screenshots

`node scripts/screenshots/capture.js` regenerates `docs/images/*.png`.

It loads the real `media/` webview assets in `harness.html` (stub VS Code API, Dark Modern theme variables, fake data from `mock.js`) and captures them with headless Edge or Chrome. Run `npm run compile` first (layout, settings and status card come from `out/`). Set `BROWSER_EXE` if the browser is not found. `chat-band.png` is an HTML illustration, not a capture of the mod.
