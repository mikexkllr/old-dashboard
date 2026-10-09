# old-dashboard

A photo frame and Home Assistant panel for iPads that are stuck on iOS 12.

Old iPads can't run most modern apps, but Safari still loads plain web pages. This project keeps the modern parts on a small server and gives the iPad a page that iOS 12 Safari can run:

- **Photo frame:** a full-screen slideshow of random photos from [Immich](https://immich.app), with a clock and the date each photo was taken.
- **Home panel:** tap the photo to see your Home Assistant lights, switches, blinds, scenes, scripts and sensors. The panel returns to the photos after a minute.

The server talks to Immich and Home Assistant, so their keys never reach the iPad. It runs as one Docker container and has no npm dependencies at runtime.

## What you need

- A Docker host, for example a home server running Portainer
- Immich, and an API key for it
- Home Assistant, and a long-lived access token for it
- An iPad that runs iOS 12, with Safari

## Setup

### 1. Create an Immich API key

In Immich, open your account settings, go to API keys, and create a key with the `asset.read` and `asset.view` permissions.

Immich's preview images must be JPEG. Set the preview image format to JPEG in Immich's admin settings (config key `image.preview.format`). iOS 12 cannot display WebP. If Immich sends WebP, the dashboard reports that clearly instead of showing broken pictures.

### 2. Create a Home Assistant token

In Home Assistant, open your user profile and create a long-lived access token in the Security section. Copy the whole token; it is only shown once.

### 3. Deploy with Portainer

1. In Portainer, go to **Stacks > Add stack > Repository**.
2. Set the repository URL to `https://github.com/mikexkllr/old-dashboard`, the reference to `refs/heads/main`, and the compose path to `docker-compose.yml`.
3. Add the environment variables from the table below. At minimum set `IMMICH_URL`, `IMMICH_API_KEY`, `HA_URL`, `HA_TOKEN` and `HA_ENTITIES`.
4. Deploy the stack. The dashboard is then at `http://<server>:8080`. Change `DASHBOARD_PORT` to use another port.

To update later, pull and redeploy the stack in Portainer. If the old image is still running, rebuild on the server with `docker compose up -d --build` in the stack's folder.

Without Portainer, run `cp .env.example .env`, edit it, then `docker compose up -d --build`.

### 4. Set up the iPad

1. In Safari, open `http://<server>:8080`. Check that the clock and photos appear.
2. Tap **Share**, then **Add to Home Screen**, and open the new icon. The dashboard then runs full screen.
3. Go to **Settings > Display & Brightness > Auto-Lock** and choose **Never**. iOS 12 gives web pages no way to keep the screen on, so this setting is what keeps the frame lit.
4. Keep the iPad plugged in.
5. Optional: go to **Settings > General > Accessibility > Guided Access** and turn it on. Then open the dashboard and triple-click the Home button (the top button on iPads without one). This locks the iPad to the dashboard.

## Settings

| Variable | Default | What it does |
| --- | --- | --- |
| `IMMICH_URL` | none | Immich address, for example `http://192.168.1.10:2283`. Needs `IMMICH_API_KEY`. |
| `IMMICH_API_KEY` | none | Immich API key from step 1. |
| `IMMICH_ALBUM_IDS` | whole library | Comma-separated album IDs to show. |
| `IMMICH_FAVORITES_ONLY` | `false` | Show only favourite photos. |
| `IMMICH_PLAYLIST_SIZE` | `200` | Photos fetched per batch, up to 1000. |
| `HA_URL` | none | Home Assistant address, for example `http://homeassistant.local:8123`. Needs `HA_TOKEN`. |
| `HA_TOKEN` | none | Long-lived access token from step 2. |
| `HA_ENTITIES` | none | Comma-separated entity IDs for the home panel. Only these can be seen or controlled. |
| `SLIDE_INTERVAL_SECONDS` | `60` | Seconds each photo stays on screen. |
| `PHOTO_FIT` | `auto` | `auto` fills the screen when a photo's shape is close to the screen's, and shows the whole photo when they differ a lot (a portrait photo on a landscape screen, for example). `cover` always fills, `contain` always shows the whole photo. |
| `SHOW_CLOCK` | `true` | Show the clock and date over the photos. |
| `SHOW_CAPTIONS` | `true` | Show the date each photo was taken, bottom right. |
| `PANEL_IDLE_SECONDS` | `60` | Seconds without a tap before the home panel returns to the photos. |
| `PORT` | `3000` | Port inside the container. |
| `DASHBOARD_PORT` | `8080` | Port on the host (docker compose only). |

Photos and Home Assistant are optional and independent. A clock-only frame works with neither set. A half-filled pair, such as a URL without its key, stops the container at startup with a message saying what is missing.

## Home Assistant entities

- **Toggled on tap:** `light`, `switch`, `input_boolean`, `fan`, `automation`, `cover`.
- **Run on tap:** `scene`, `script`, `button`, `input_button`.
- **Shown only:** everything else, such as sensors, binary sensors, climate and locks. Locks are display-only on purpose.

Only the IDs in `HA_ENTITIES` appear on the panel, and the server refuses actions on any other entity. The names come from Home Assistant's friendly names, so rename entities there.

## Photos

- Photos are picked at random from the whole library, or from `IMMICH_ALBUM_IDS`.
- Only photos in the timeline are used. Archived, hidden and locked photos, videos, trashed photos and offline files are skipped.
- The dashboard asks Immich for a fresh random batch when it runs out, so the frame keeps changing without a restart.

## Security

- The dashboard has no login. Anyone who can reach its port can see the photos and use the entities in `HA_ENTITIES`. Keep it on your home network or a VPN, and do not forward its port to the internet.
- The Immich key and the Home Assistant token stay on the server. They are never sent to the browser.

## Development

```bash
npm test     # the test suite, using mock Immich and Home Assistant servers
npm start    # needs the environment variables from .env.example
```

Requires Node.js 22 or newer. The only dev dependency is `acorn`, which the tests use to check the frontend.

## iOS 12 compatibility

- The page script is plain ES5, and the stylesheet avoids newer CSS such as flexbox `gap`, CSS variables and `clamp()`. `npm test` checks both.
- The browser code uses `XMLHttpRequest` rather than `fetch`.
- Taps use `<button>` elements, and the frame's click handler is set as a property, which older iOS Safari reliably dispatches.
- The page reloads itself if the slideshow stalls, and once a day, to keep memory in check.
- The browser features the page relies on were checked against MDN's compatibility data for iOS Safari.

## Status

- The server and the page are covered by `npm test`, and the page was checked in a desktop Chromium at iPad sizes with the mock servers.
- The Immich integration is written against Immich's API spec for version 3.3. Immich 3.2 and later use the `filter` search, and older servers use the top-level search fields. Both shapes are covered by tests with mock servers, but neither has been run against a live Immich server yet.
- This has not yet been tested on a real iOS 12 iPad. If something breaks there, please open an issue with the iPad model and iOS version.

## License

MIT. See [LICENSE](LICENSE).
