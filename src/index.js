import { createApp } from './app.js';
import { loadConfig } from './config.js';
import { createHomeAssistantClient } from './homeassistant.js';
import { createImmichClient } from './immich.js';

let config;
try {
  config = loadConfig(process.env);
} catch (err) {
  console.error(`Configuration error: ${err.message}`);
  process.exit(1);
}

const immich = createImmichClient(config.immich);
const homeAssistant = createHomeAssistantClient(config.homeAssistant);
const server = createApp({ config, immich, homeAssistant });

if (immich.enabled) {
  const albums = config.immich.albumIds.length
    ? `${config.immich.albumIds.length} album(s)`
    : 'whole library';
  console.log(`Photos: Immich at ${config.immich.url} (${albums})`);
} else {
  console.log('Photos: off (set IMMICH_URL and IMMICH_API_KEY to enable)');
}

if (homeAssistant.enabled) {
  console.log(`Home Assistant: ${config.homeAssistant.url} (${config.homeAssistant.entityIds.length} entities)`);
} else {
  console.log('Home Assistant: off (set HA_URL and HA_TOKEN to enable)');
}

server.listen(config.port, () => {
  console.log(`Dashboard listening on port ${config.port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
  server.closeAllConnections();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
