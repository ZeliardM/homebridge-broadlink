const BroadlinkClient = require('./broadlinkClient');
const DirigeraOutletClient = require('./dirigeraOutletClient');

const HEAT_STATES = ['off', 'low', 'high'];

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function asNumber(value, fallback, min = 0) {
  const number = Number(value);
  if (!Number.isFinite(number) || number < min) {
    return fallback;
  }

  return number;
}

function logWith(log, level, message, ...args) {
  if (typeof log?.[level] === 'function') {
    log[level](message, ...args);
    return;
  }

  if (typeof log === 'function') {
    log(message, ...args);
  }
}

class FireplaceAccessory {
  constructor(log, config) {
    this.log = log;
    this.config = config;
    this.name = config.name || 'Fireplace';
    this.outletOn = false;
    this.started = false;
    this.awake = false;
    this.heatState = 'off';
    this.commandQueue = Promise.resolve();
    this.awakeTimer = null;
    this.startupInProgress = false;

    this.timings = {
      startupDelayMs: asNumber(config.startupDelayMs, 4000, 0),
      awakeDurationMs: asNumber(config.awakeDurationMs, 4000, 500),
      wakeDelayMs: asNumber(config.wakeDelayMs, 750, 0),
      heatPressDelayMs: asNumber(config.heatPressDelayMs, 750, 0),
    };

    this.broadlink = new BroadlinkClient({
      log,
      debug: Boolean(config.debug),
    });
    this.outlet = new DirigeraOutletClient(this.getDirigeraConfig(), log);

    this.setupServices();
    this.startOutletClient();
  }

  setupServices() {
    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Local Broadlink Fireplace')
      .setCharacteristic(Characteristic.Model, 'Broadlink IR + DIRIGERA Outlet')
      .setCharacteristic(Characteristic.SerialNumber, this.config.ip || 'unknown');

    this.powerService = new Service.Outlet(`${this.name} Power`, 'fireplace-power');
    this.powerService
      .getCharacteristic(Characteristic.On)
      .on('get', (callback) => callback(null, this.outletOn))
      .on('set', (value, callback) => this.handlePowerSet(Boolean(value), callback));

    this.powerService
      .getCharacteristic(Characteristic.OutletInUse)
      .on('get', (callback) => callback(null, this.outletOn));

    this.heatLowService = this.createHeatService(`${this.name} Heat Low`, 'low');
    this.heatHighService = this.createHeatService(`${this.name} Heat High`, 'high');
    this.heatOffService = this.createHeatService(`${this.name} Heat Off`, 'off');
    this.updateHomeKitState();
  }

  createHeatService(name, mode) {
    const service = new Service.Switch(name, `heat-${mode}`);

    service
      .getCharacteristic(Characteristic.On)
      .on('get', (callback) => callback(null, this.getVisibleHeatSwitchState(mode)))
      .on('set', (value, callback) => this.handleHeatSet(mode, Boolean(value), callback));

    return service;
  }

  getServices() {
    return [
      this.informationService,
      this.powerService,
      this.heatLowService,
      this.heatHighService,
      this.heatOffService,
    ];
  }

  getDirigeraConfig() {
    return {
      gatewayIP: this.config.dirigeraGatewayIP,
      accessToken: this.config.dirigeraAccessToken,
      outletId: this.config.dirigeraOutletId,
    };
  }

  getBroadlinkConfig() {
    return {
      ip: this.config.ip,
      mac: this.config.mac,
      deviceType: this.config.deviceType,
    };
  }

  startOutletClient() {
    this.outlet.on('change', (update) => {
      this.handleOutletUpdate(update).catch((err) => {
        logWith(this.log, 'error', 'Failed to handle DIRIGERA outlet update: %s', err.message || err);
      });
    });

    this.outlet.start()
      .then((isOn) => {
        this.outletOn = Boolean(isOn);

        if (this.outletOn) {
          this.started = true;
          this.heatState = 'off';
          logWith(
            this.log,
            'info',
            'DIRIGERA outlet is already on at startup; assuming fireplace is started to avoid sending the toggle IR power command.',
          );
        }

        this.updateHomeKitState();
      })
      .catch((err) => {
        logWith(this.log, 'error', 'Could not start DIRIGERA outlet client: %s', err.message || err);
      });
  }

  handlePowerSet(value, callback) {
    this.enqueue(() => (value ? this.turnPowerOn() : this.turnPowerOff()))
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  handleHeatSet(mode, value, callback) {
    if (!value) {
      this.updateHomeKitState();
      callback(null);
      return;
    }

    this.enqueue(() => this.setHeatMode(mode))
      .then(() => callback(null))
      .catch((err) => callback(err));
  }

  enqueue(operation) {
    const run = this.commandQueue.then(operation, operation);
    this.commandQueue = run.catch(() => undefined);
    return run;
  }

  async handleOutletUpdate(update) {
    this.outletOn = Boolean(update.isOn);

    if (!this.outletOn) {
      this.resetState();
      this.updateHomeKitState();
      logWith(this.log, 'info', 'Fireplace outlet turned off; reset fireplace state.');
      return;
    }

    if (update.source === 'initial') {
      this.started = true;
      this.heatState = 'off';
      this.updateHomeKitState();
      return;
    }

    this.updateHomeKitState();

    if (this.startupInProgress || this.started) {
      return;
    }

    logWith(this.log, 'info', 'Fireplace outlet turned on externally; starting fireplace sequence.');
    await this.enqueue(() => this.startFireplaceAfterOutletOn());
  }

  async turnPowerOn() {
    if (this.outletOn && this.started) {
      this.updateHomeKitState();
      return;
    }

    this.startupInProgress = true;

    try {
      await this.setOutletPower(true);
      await this.startFireplaceAfterOutletOn();
    } catch (err) {
      this.startupInProgress = false;
      throw err;
    }
  }

  async startFireplaceAfterOutletOn() {
    this.startupInProgress = true;

    try {
      this.outletOn = true;
      this.started = false;
      this.heatState = 'off';
      this.setAwake(false);
      this.updateHomeKitState();

      await delay(this.timings.startupDelayMs);
      await this.sendIrCommand('power');

      this.started = true;
      this.heatState = 'off';
      this.markAwake();
      this.updateHomeKitState();
      logWith(this.log, 'info', 'Fireplace startup complete. Heat state reset to off.');
    } finally {
      this.startupInProgress = false;
    }
  }

  async turnPowerOff() {
    await this.setOutletPower(false);
    this.resetState();
    this.updateHomeKitState();
    logWith(this.log, 'info', 'Fireplace outlet turned off. No IR power command was sent.');
  }

  async setHeatMode(targetMode) {
    if (!HEAT_STATES.includes(targetMode)) {
      throw new Error(`Unsupported fireplace heat mode: ${targetMode}`);
    }

    await this.ensureStarted();

    const pressCount = this.getHeatPressCount(this.heatState, targetMode);
    if (pressCount === 0) {
      this.heatState = targetMode;
      this.updateHomeKitState();
      return;
    }

    if (!this.awake) {
      await this.sendIrCommand('heat', 'heat wake');
      await delay(this.timings.wakeDelayMs);
    }

    for (let index = 0; index < pressCount; index++) {
      await this.sendIrCommand('heat', `heat ${index + 1}/${pressCount}`);

      if (index < pressCount - 1) {
        await delay(this.timings.heatPressDelayMs);
      }
    }

    this.heatState = targetMode;
    this.markAwake();
    this.updateHomeKitState();
    logWith(this.log, 'info', 'Fireplace heat state is now %s.', targetMode);
  }

  async ensureStarted() {
    if (!this.outletOn) {
      await this.turnPowerOn();
      return;
    }

    if (this.started) {
      return;
    }

    await this.sendIrCommand('power');
    this.started = true;
    this.heatState = 'off';
    this.markAwake();
    this.updateHomeKitState();
  }

  getHeatPressCount(currentMode, targetMode) {
    const currentIndex = HEAT_STATES.indexOf(currentMode);
    const targetIndex = HEAT_STATES.indexOf(targetMode);
    return (targetIndex - currentIndex + HEAT_STATES.length) % HEAT_STATES.length;
  }

  getVisibleHeatSwitchState(mode) {
    return this.outletOn && this.heatState === mode;
  }

  async setOutletPower(isOn) {
    if (!this.outlet.isConfigured) {
      throw new Error('DIRIGERA outlet is not configured, so Fireplace Power cannot be changed.');
    }

    await this.outlet.setPower(isOn);
    this.outletOn = isOn;
  }

  async sendIrCommand(command, label = command) {
    const code = command === 'power' ? this.config.powerCode : this.config.heatCode;
    await this.broadlink.send(this.getBroadlinkConfig(), code, label);
  }

  resetState() {
    this.outletOn = false;
    this.started = false;
    this.heatState = 'off';
    this.setAwake(false);
  }

  markAwake() {
    this.setAwake(true);

    this.awakeTimer = setTimeout(() => {
      this.awake = false;
    }, this.timings.awakeDurationMs);

    this.awakeTimer.unref?.();
  }

  setAwake(value) {
    if (this.awakeTimer) {
      clearTimeout(this.awakeTimer);
      this.awakeTimer = null;
    }

    this.awake = value;
  }

  updateHomeKitState() {
    this.powerService?.updateCharacteristic(Characteristic.On, this.outletOn);
    this.powerService?.updateCharacteristic(Characteristic.OutletInUse, this.outletOn);
    this.heatLowService?.updateCharacteristic(Characteristic.On, this.getVisibleHeatSwitchState('low'));
    this.heatHighService?.updateCharacteristic(Characteristic.On, this.getVisibleHeatSwitchState('high'));
    this.heatOffService?.updateCharacteristic(Characteristic.On, this.getVisibleHeatSwitchState('off'));
  }
}

module.exports = FireplaceAccessory;
