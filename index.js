const BroadlinkFireplacePlatform = require('./platform');

const PLUGIN_NAME = 'homebridge-broadlink';
const PLATFORM_NAME = 'BroadlinkPlatform';

module.exports = (homebridge) => {
  global.Service = homebridge.hap.Service;
  global.Characteristic = homebridge.hap.Characteristic;

  BroadlinkFireplacePlatform.setHomebridge(homebridge);
  homebridge.registerPlatform(PLUGIN_NAME, PLATFORM_NAME, BroadlinkFireplacePlatform);
};
