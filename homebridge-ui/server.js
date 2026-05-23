const BroadlinkClient = require('../lib/broadlinkClient');

let RequestErrorClass;

class ConsoleLogger {
  info(...args) {
    console.log(...args);
  }

  warn(...args) {
    console.warn(...args);
  }

  error(...args) {
    console.error(...args);
  }

  debug(...args) {
    if (process.env.DEBUG) {
      console.debug(...args);
    }
  }
}

function requestError(message, status = 400) {
  if (RequestErrorClass) {
    return new RequestErrorClass(message, { status });
  }

  const err = new Error(message);
  err.requestError = { status };
  return err;
}

function getRequiredString(payload, field, label) {
  const value = String(payload?.[field] || '').trim();
  if (!value) {
    throw requestError(`${label} is required.`);
  }

  return value;
}

function getDevice(payload) {
  const device = payload?.device || {};
  return {
    ...device,
    ip: getRequiredString(device, 'ip', 'Broadlink IP address'),
  };
}

function commandLabel(codeKey) {
  if (codeKey === 'powerCode') {
    return 'Power';
  }
  if (codeKey === 'heatCode') {
    return 'Heat';
  }

  throw requestError('Choose Power or Heat.');
}

async function createDirigeraClient(payload) {
  const gatewayIP = getRequiredString(payload, 'gatewayIP', 'DIRIGERA gateway IP');
  const { createDirigeraClient } = await import('dirigera');

  return createDirigeraClient({
    gatewayIP,
    accessToken: payload?.accessToken,
    rejectUnauthorized: false,
  });
}

function outletName(outlet) {
  return outlet?.attributes?.customName || outlet?.attributes?.model || outlet?.id || 'Unnamed outlet';
}

;(async () => {
  const { HomebridgePluginUiServer, RequestError } = await import('@homebridge/plugin-ui-utils');
  RequestErrorClass = RequestError;

  class BroadlinkFireplaceUiServer extends HomebridgePluginUiServer {
    constructor() {
      super();

      this.onRequest('/broadlink-connect', this.connectBroadlink.bind(this));
      this.onRequest('/learn-ir', this.learnIr.bind(this));
      this.onRequest('/send-ir', this.sendIr.bind(this));
      this.onRequest('/dirigera-authenticate', this.authenticateDirigera.bind(this));
      this.onRequest('/dirigera-outlets', this.listDirigeraOutlets.bind(this));

      this.ready();
    }

    async connectBroadlink(payload) {
      const broadlink = new BroadlinkClient({ log: new ConsoleLogger() });
      const device = await broadlink.connect(getDevice(payload));

      return {
        ip: device.host.address,
        mac: BroadlinkClient.formatMac(device.mac),
        deviceType: device.type,
        deviceTypeHex: `0x${Number(device.type).toString(16)}`,
        model: device.model || 'Broadlink RM',
      };
    }

    async learnIr(payload) {
      const codeKey = String(payload?.codeKey || '');
      const label = commandLabel(codeKey);
      const broadlink = new BroadlinkClient({ log: new ConsoleLogger() });
      const code = await broadlink.learn(getDevice(payload), label, 30000);

      return {
        codeKey,
        code,
        label,
      };
    }

    async sendIr(payload) {
      const codeKey = String(payload?.codeKey || '');
      const label = commandLabel(codeKey);
      const code = getRequiredString(payload, 'code', `${label} IR code`);
      const broadlink = new BroadlinkClient({ log: new ConsoleLogger() });

      await broadlink.send(getDevice(payload), code, label);
      return { ok: true };
    }

    async authenticateDirigera(payload) {
      const client = await createDirigeraClient(payload);
      const accessToken = await client.authenticate({ verbose: false });
      return { accessToken };
    }

    async listDirigeraOutlets(payload) {
      const accessToken = getRequiredString(payload, 'accessToken', 'DIRIGERA access token');
      const client = await createDirigeraClient({ ...payload, accessToken });
      const outlets = await client.outlets.list();

      return outlets.map((outlet) => ({
        id: outlet.id,
        name: outletName(outlet),
        model: outlet.attributes?.model || '',
        manufacturer: outlet.attributes?.manufacturer || '',
        isOn: Boolean(outlet.attributes?.isOn),
        isReachable: Boolean(outlet.isReachable),
        roomName: outlet.room?.name || '',
      }));
    }
  }

  return new BroadlinkFireplaceUiServer();
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
