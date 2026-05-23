const { EventEmitter } = require('events');

function logWith(log, level, message, ...args) {
  if (typeof log?.[level] === 'function') {
    log[level](message, ...args);
    return;
  }

  if (typeof log === 'function') {
    log(message, ...args);
  }
}

function required(value, label) {
  const text = String(value || '').trim();
  if (!text) {
    throw new Error(`${label} is required.`);
  }

  return text;
}

class DirigeraOutletClient extends EventEmitter {
  constructor(config = {}, log) {
    super();
    this.config = config;
    this.log = log;
    this.client = null;
    this.currentIsOn = false;
  }

  get isConfigured() {
    return Boolean(this.config.gatewayIP && this.config.accessToken && this.config.outletId);
  }

  async start() {
    if (!this.isConfigured) {
      logWith(this.log, 'warn', 'DIRIGERA outlet is not configured. Fireplace Power will not control the real outlet yet.');
      return false;
    }

    await this.ensureClient();
    const outlet = await this.client.outlets.get({ id: this.config.outletId });
    this.applyOutlet(outlet, 'initial');

    this.client.startListeningForUpdates((event) => {
      if (event?.type !== 'deviceStateChanged') {
        return;
      }
      if (event.data?.id !== this.config.outletId) {
        return;
      }
      if (typeof event.data?.attributes?.isOn !== 'boolean') {
        return;
      }

      this.applyPower(event.data.attributes.isOn, 'event');
    });

    return this.currentIsOn;
  }

  async ensureClient() {
    if (this.client) {
      return this.client;
    }

    const gatewayIP = required(this.config.gatewayIP, 'DIRIGERA gateway IP');
    const accessToken = required(this.config.accessToken, 'DIRIGERA access token');
    const { createDirigeraClient } = await import('dirigera');

    this.client = await createDirigeraClient({
      gatewayIP,
      accessToken,
      rejectUnauthorized: false,
    });

    logWith(this.log, 'info', 'Connected to DIRIGERA gateway at %s for fireplace outlet.', gatewayIP);
    return this.client;
  }

  async getPower() {
    await this.ensureClient();
    const outlet = await this.client.outlets.get({ id: this.config.outletId });
    this.applyOutlet(outlet, 'poll');
    return this.currentIsOn;
  }

  async setPower(isOn) {
    if (!this.isConfigured) {
      throw new Error('DIRIGERA outlet is not configured.');
    }

    await this.ensureClient();
    await this.client.outlets.setIsOn({ id: this.config.outletId, isOn });
    this.applyPower(isOn, 'command');
  }

  stop() {
    try {
      this.client?.stopListeningForUpdates?.();
    } catch (err) {
      logWith(this.log, 'debug', 'Failed to stop DIRIGERA outlet listener: %s', err.message || err);
    }
  }

  applyOutlet(outlet, source) {
    const isOn = Boolean(outlet?.attributes?.isOn);
    this.applyPower(isOn, source);
  }

  applyPower(isOn, source) {
    const changed = this.currentIsOn !== isOn;
    this.currentIsOn = isOn;

    if (changed || source === 'initial') {
      this.emit('change', {
        isOn,
        source,
      });
    }
  }
}

module.exports = DirigeraOutletClient;
