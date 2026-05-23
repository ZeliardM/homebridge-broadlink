const FireplaceAccessory = require('./lib/fireplaceAccessory');

let homebridgeRef;

function logInfo(log, message, ...args) {
  if (typeof log?.info === 'function') {
    log.info(message, ...args);
    return;
  }

  if (typeof log === 'function') {
    log(message, ...args);
  }
}

function logWarn(log, message, ...args) {
  if (typeof log?.warn === 'function') {
    log.warn(message, ...args);
    return;
  }

  logInfo(log, message, ...args);
}

class BroadlinkFireplacePlatform {
  constructor(log, config = {}) {
    this.log = log;
    this.config = config;
    this.homebridge = homebridgeRef;
  }

  accessories(callback) {
    const deviceConfig = this.config.device || {};
    const name = String(deviceConfig.name || '').trim();
    const ip = String(deviceConfig.ip || deviceConfig.host || '').trim();

    if (!name || !ip) {
      logWarn(this.log, 'Broadlink fireplace is not configured yet. Add a fireplace name and Broadlink IP in the plugin settings.');
      callback([]);
      return;
    }

    logInfo(this.log, 'Adding fireplace accessory: %s at %s', name, ip);
    callback([
      new FireplaceAccessory(this.log, {
        ...deviceConfig,
        name,
        ip,
      }),
    ]);
  }
}

BroadlinkFireplacePlatform.setHomebridge = (homebridge) => {
  homebridgeRef = homebridge;
};

module.exports = BroadlinkFireplacePlatform;
