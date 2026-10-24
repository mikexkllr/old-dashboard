# old-dashboard

A photo frame and Home Assistant panel for iPads that are stuck on iOS 12.

Old iPads can't run most modern apps, but Safari still loads plain web pages. This project keeps the modern parts on a small server and gives the iPad a page that iOS 12 Safari can run:

- **Photo frame:** a full-screen slideshow of random photos from [Immich](https://immich.app), with a clock and the date each photo was taken.
- **Screensaver:** the photos are what the screen shows when nobody is using it.
- **Home panel:** tap the photo to open the controls. They are loaded from Home Assistant: every light (with brightness), room by room, plus covers, switches, scenes, climate and sensors. The panel returns to the photos after a minute without a tap.

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

Portainer builds the dashboard from this repository, and redeploys it whenever `main` changes.

1. In Portainer, go to **Stacks > Add stack** and name it `old-dashboard`.
2. Select **Git Repository**, and choose or create a Git source for `https://github.com/mikexkllr/old-dashboard`. No login is needed, because the repository is public.
3. Set the repository reference to `refs/heads/main` and the compose path to `docker-compose.yml`.
4. Under **GitOps updates**, turn the setting on, choose **Polling**, and set the fetch interval to 5 minutes. Leave **Re-pull image** and **Force redeployment** off.
5. Under **Environment variables**, enter the values from the [Settings](#settings) table, or upload a `.env` file that contains them.
6. Click **Deploy the stack**. The dashboard is then at `http://<umbrel-ip>:<DASHBOARD_PORT>`.

**Automatic updates.** After a push to `main`, Portainer sees the new commit within the fetch interval, rebuilds the image and restarts the container. The iPad reloads itself when the new server starts, unless the home panel is open at that moment. To update straight away, use **Pull and redeploy** on the stack.

**Umbrel values.** The dashboard reaches Immich and Home Assistant through the Umbrel's IP address:

- `IMMICH_URL=http://<umbrel-ip>:2283` for Immich
- `HA_URL=http://<umbrel-ip>:8123` for Home Assistant

Use the IP address, not `umbrel.local`, because containers can't resolve `.local` names. With a `.local` name, the dashboard warns in its log at startup, and the panel names the cause when it cannot connect. Give the Umbrel a fixed IP address in your router so these URLs keep working. Check both before you deploy:

```bash
curl http://<umbrel-ip>:2283/api/server/version
curl -H "Authorization: Bearer <HA_TOKEN>" http://<umbrel-ip>:8123/api/
```

The first command returns the Immich version, with no login. The second returns `{"message": "API running."}`.

Several Umbrel apps use port 8080, so on the Umbrel set `DASHBOARD_PORT=8585`, which none of the official Umbrel apps uses.

Without Portainer, run `cp .env.example .env`, edit it, then `docker compose up -d --build`.

### 4. Set up the iPad

1. In Safari, open `http://<server>:<DASHBOARD_PORT>` (port 8080 unless you changed it). Check that the clock and photos appear.
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
| `HA_URL` | none | Home Assistant address, for example `http://192.168.1.10:8123`. Use an IP address, because containers can't resolve `.local` names. Needs `HA_TOKEN`. |
| `HA_TOKEN` | none | Long-lived access token from step 2. |
| `HA_ENTITIES` | none | Extra entities to show and control, on top of the ones found automatically. Use it for scripts, automations, buttons, groups and garage, door or gate covers. See [Home Assistant entities](#home-assistant-entities). |
| `HA_HIDE_ENTITIES` | none | Entities to leave off the panel, for example noisy sensors. |
| `SLIDE_INTERVAL_SECONDS` | `60` | Seconds each photo stays on screen. |
| `PHOTO_FIT` | `auto` | `auto` fills the screen when a photo's shape is close to the screen's, and shows the whole photo when they differ a lot (a portrait photo on a landscape screen, for example). `cover` always fills, `contain` always shows the whole photo. |
| `SHOW_CLOCK` | `true` | Show the clock and date over the photos. |
| `SHOW_CAPTIONS` | `true` | Show the date each photo was taken, bottom right. |
| `PANEL_IDLE_SECONDS` | `60` | Seconds without a tap before the home panel returns to the photos. |
| `PORT` | `3000` | Port inside the container. |
| `DASHBOARD_PORT` | `8080` | Port on the host (docker compose only). |

Photos and Home Assistant are optional and independent. A clock-only frame works with neither set. A half-filled pair, such as a URL without its key, stops the container at startup with a message saying what is missing.

## Home Assistant entities

The panel is built from what Home Assistant reports, so new lights and rooms appear without any configuration. Every tab lists its entities by room. The tabs are:

- **Rooms:** every entity, grouped by the room (area) it belongs to in Home Assistant. When lights are on in a room, it gets an **All off** button, which turns off the lights the panel shows there (hidden lights are left alone). Entities without a room are listed under **No room**.
- **Lights:** every light, by room. Dimmable lights have a brightness slider.
- **Covers:** blinds and shutters, with open, stop and close.
- **Switches:** switches, fans and input booleans.
- **Scenes:** scenes.
- **Climate:** the target temperature, changed with − and +. The step is the thermostat's own (0.5 °C when it does not report one), and the limits are the thermostat's minimum and maximum.
- **Status:** sensors, binary sensors, locks, media players and anything else. These are read-only, and locks and alarms can never be controlled from the dashboard.

A few kinds of entity stay off the panel until you list them in `HA_ENTITIES`, because they can run actions or open things: scripts, automations, buttons, groups, and covers for doors, garages and gates. Listed scripts and buttons run when tapped, and listed automations are toggled. Internal entities such as people, zones, the sun, updates and cameras never appear.

`HA_HIDE_ENTITIES` removes any entity from the panel, including one you listed. The names come from Home Assistant's friendly names, so rename entities there.

## Photos

- Photos are picked at random from the whole library, or from `IMMICH_ALBUM_IDS`.
- Only photos in the timeline are used. Archived, hidden and locked photos, videos, trashed photos and offline files are skipped.
- The dashboard asks Immich for a fresh random batch when it runs out, so the frame keeps changing without a restart.

## Security

- The dashboard has no login. Anyone who can reach its port can see the photos and control the entities on the panel. Keep it on your home network or a VPN, and do not forward its port to the internet.
- Garage, door and gate covers, scripts, automations and buttons are not reachable until you list them in `HA_ENTITIES`. Locks and alarms cannot be controlled at all.
- Every command is checked on the server against the entity's current state and its allowed commands, so the browser cannot ask for anything the panel does not offer.
- Portainer deploys whatever is on `main`, so only you should be able to push to this repository. Anyone who can push there can change what runs on your server.
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

- The server and the page are covered by `npm test`. The page was checked with the mock servers in a desktop Chromium at iPad and phone sizes, and rendered in macOS WebKit, the engine behind Safari.
- The Home Assistant side was checked against Home Assistant's core source for the service names and attributes it uses. The room template was rendered with Jinja2 and parsed by the server, and the tests use a mock Home Assistant that keeps state and applies services.
- The Immich integration is written against Immich's API spec for version 3.3. Immich 3.2 and later use the `filter` search, and older servers use the top-level search fields. Both shapes are covered by tests with mock servers, but neither has been run against a live Immich server yet.
- This has not yet been tested on a real iOS 12 iPad. If something breaks there, please open an issue with the iPad model and iOS version.

## License

MIT. See [LICENSE](LICENSE).
