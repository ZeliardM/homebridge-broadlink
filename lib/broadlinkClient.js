const dgram = require('dgram');
const os = require('os');
const { format } = require('util');

const BroadlinkJS = require('kiwicam-broadlinkjs-rm');

const DISCOVERY_PORT = 80;
const DEFAULT_DISCOVERY_TIMEOUT_MS = 6000;
const DEFAULT_CONNECT_TIMEOUT_MS = 8000;
const DEFAULT_LEARN_TIMEOUT_MS = 30000;

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function logWith(log, level, message, ...args) {
  const text = format(message, ...args);

  if (typeof log?.[level] === 'function') {
    log[level](text);
    return;
  }

  if (typeof log === 'function') {
    log(text);
  }
}

function normalizeIp(value) {
  const ip = String(value || '').trim();
  if (!ip) {
    throw new Error('Broadlink IP address is required.');
  }

  return ip;
}

function normalizeHex(value, label) {
  const hex = String(value || '').trim().replace(/\s+/g, '');
  if (!hex) {
    throw new Error(`${label} IR code has not been learned yet.`);
  }
  if (hex.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(hex)) {
    throw new Error(`${label} IR code is not valid Broadlink hex.`);
  }

  return hex;
}

function normalizeMac(value) {
  const text = String(value || '').trim();
  if (!text) {
    return '';
  }

  const hex = text.replace(/[^0-9a-f]/gi, '').toLowerCase();
  if (hex.length !== 12) {
    throw new Error('Stored Broadlink MAC address is invalid.');
  }

  return hex;
}

function formatMac(bufferOrHex) {
  const hex = Buffer.isBuffer(bufferOrHex)
    ? bufferOrHex.toString('hex')
    : String(bufferOrHex || '').replace(/[^0-9a-f]/gi, '').toLowerCase();

  return (hex.match(/.{1,2}/g) || []).join(':');
}

function getIpv4Addresses() {
  return Object.values(os.networkInterfaces())
    .flat()
    .filter((address) => address && !address.internal && (address.family === 'IPv4' || address.family === 4))
    .map((address) => address.address);
}

function createDiscoveryPacket(localIp, localPort) {
  const now = new Date();
  const packet = Buffer.alloc(0x30, 0);
  const splitIp = localIp.split('.');
  const timezone = now.getTimezoneOffset() / -3600;
  const year = now.getYear();
  const subyear = year % 100;

  if (timezone < 0) {
    packet[0x08] = 0xff + timezone - 1;
    packet[0x09] = 0xff;
    packet[0x0a] = 0xff;
    packet[0x0b] = 0xff;
  } else {
    packet[0x08] = timezone;
  }

  packet[0x0c] = year & 0xff;
  packet[0x0d] = year >> 8;
  packet[0x0e] = now.getMinutes();
  packet[0x0f] = now.getHours();
  packet[0x10] = subyear;
  packet[0x11] = now.getDay();
  packet[0x12] = now.getDate();
  packet[0x13] = now.getMonth();
  packet[0x18] = Number(splitIp[0]);
  packet[0x19] = Number(splitIp[1]);
  packet[0x1a] = Number(splitIp[2]);
  packet[0x1b] = Number(splitIp[3]);
  packet[0x1c] = localPort & 0xff;
  packet[0x1d] = localPort >> 8;
  packet[0x26] = 6;

  let checksum = 0xbeaf;
  for (let i = 0; i < packet.length; i++) {
    checksum += packet[i];
  }
  checksum &= 0xffff;
  packet[0x20] = checksum & 0xff;
  packet[0x21] = checksum >> 8;

  return packet;
}

function parseDiscoveryResponse(message, host) {
  if (!message || message.length < 0x40) {
    throw new Error('Broadlink discovery response was incomplete.');
  }

  const mac = Buffer.alloc(6, 0);
  message.copy(mac, 0x00, 0x3f);
  message.copy(mac, 0x01, 0x3e);
  message.copy(mac, 0x02, 0x3d);
  message.copy(mac, 0x03, 0x3c);
  message.copy(mac, 0x04, 0x3b);
  message.copy(mac, 0x05, 0x3a);

  return {
    address: host.address,
    port: DISCOVERY_PORT,
    mac: formatMac(mac),
    macBuffer: mac,
    deviceType: message[0x34] | (message[0x35] << 8),
    isLocked: Boolean(message[0x7f]),
  };
}

function discoverBroadlinkDevice(ip, timeoutMs = DEFAULT_DISCOVERY_TIMEOUT_MS, log) {
  const targetIp = normalizeIp(ip);
  const localIps = getIpv4Addresses();
  const discoveryTargets = targetIp === '255.255.255.255'
    ? [targetIp]
    : [targetIp, '255.255.255.255'];

  if (localIps.length === 0) {
    return Promise.reject(new Error('No local IPv4 network interface is available for Broadlink discovery.'));
  }

  return new Promise((resolve, reject) => {
    const sockets = [];
    let settled = false;

    const finish = (err, result) => {
      if (settled) {
        return;
      }

      settled = true;
      clearTimeout(timeout);

      sockets.forEach((socket) => {
        try {
          socket.close();
        } catch {
          // Socket may already be closed.
        }
      });

      if (err) {
        reject(err);
      } else {
        resolve(result);
      }
    };

    const timeout = setTimeout(() => {
      finish(new Error(`Timed out waiting for Broadlink device at ${targetIp}.`));
    }, timeoutMs);

    localIps.forEach((localIp) => {
      const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });
      sockets.push(socket);

      socket.on('error', (err) => {
        logWith(log, 'debug', 'Broadlink discovery socket error on %s: %s', localIp, err.message || err);
      });

      socket.on('message', (message, host) => {
        if (host.address !== targetIp) {
          return;
        }

        try {
          finish(null, parseDiscoveryResponse(message, host));
        } catch (err) {
          finish(err);
        }
      });

      socket.on('listening', () => {
        const localPort = socket.address().port;
        const packet = createDiscoveryPacket(localIp, localPort);
        socket.setBroadcast(true);

        discoveryTargets.forEach((destination) => {
          socket.send(packet, 0, packet.length, DISCOVERY_PORT, destination, (err) => {
            if (err) {
              logWith(log, 'debug', 'Could not send Broadlink discovery packet from %s to %s: %s', localIp, destination, err.message || err);
            }
          });
        });
      });

      socket.bind(0, localIp);
    });
  });
}

class BroadlinkClient {
  constructor({ log, debug = false } = {}) {
    this.log = log;
    this.debug = debug;
    this.broadlink = new BroadlinkJS();
    this.broadlink.log = (message, ...args) => logWith(this.log, 'info', message, ...args);
    this.broadlink.debug = debug;
    this.queue = Promise.resolve();
  }

  async resolveMetadata(config) {
    const ip = normalizeIp(config.ip || config.host);
    const mac = normalizeMac(config.mac);
    const deviceType = Number(config.deviceType);

    if (mac && Number.isFinite(deviceType) && deviceType > 0) {
      return {
        address: ip,
        port: DISCOVERY_PORT,
        mac: formatMac(mac),
        macBuffer: Buffer.from(mac, 'hex'),
        deviceType,
      };
    }

    logWith(this.log, 'info', 'Resolving Broadlink device at %s.', ip);
    const metadata = await discoverBroadlinkDevice(ip, DEFAULT_DISCOVERY_TIMEOUT_MS, this.log);

    if (metadata.isLocked) {
      throw new Error(`Broadlink device at ${ip} is locked. Unlock it in the Broadlink app first.`);
    }

    return metadata;
  }

  async connect(config, timeoutMs = DEFAULT_CONNECT_TIMEOUT_MS) {
    const metadata = await this.resolveMetadata(config);
    const macKey = metadata.macBuffer.toString('hex');
    const existing = this.broadlink.devices[macKey];

    if (existing && existing !== 'Not Supported') {
      return existing;
    }

    return new Promise((resolve, reject) => {
      let settled = false;

      const finish = (err, device) => {
        if (settled) {
          return;
        }

        settled = true;
        clearTimeout(timeout);
        this.broadlink.removeListener('deviceReady', onReady);

        if (err) {
          reject(err);
        } else {
          resolve(device);
        }
      };

      const onReady = (device) => {
        if (device.mac.toString('hex') !== macKey) {
          return;
        }

        logWith(this.log, 'info', 'Connected to %s at %s (%s).', device.model, device.host.address, formatMac(device.mac));
        finish(null, device);
      };

      const timeout = setTimeout(() => {
        finish(new Error(`Timed out authenticating Broadlink device at ${metadata.address}.`));
      }, timeoutMs);

      this.broadlink.on('deviceReady', onReady);

      try {
        this.broadlink.addDevice(
          { address: metadata.address, port: metadata.port || DISCOVERY_PORT },
          metadata.macBuffer,
          metadata.deviceType,
        );
      } catch (err) {
        finish(err);
      }
    });
  }

  runExclusive(fn) {
    const next = this.queue.then(fn, fn);
    this.queue = next.catch(() => undefined);
    return next;
  }

  async send(config, code, label = 'IR') {
    const hex = normalizeHex(code, label);

    return this.runExclusive(async () => {
      const device = await this.connect(config);
      await device.sendData(Buffer.from(hex, 'hex'), this.debug);
      logWith(this.log, 'info', 'Sent %s IR command through Broadlink device at %s.', label, device.host.address);
    });
  }

  async learn(config, label = 'IR', timeoutMs = DEFAULT_LEARN_TIMEOUT_MS) {
    return this.runExclusive(async () => {
      const device = await this.connect(config);

      if (typeof device.enterLearning !== 'function') {
        throw new Error(`Broadlink device at ${device.host.address} does not support IR learning.`);
      }

      return new Promise((resolve, reject) => {
        let complete = false;
        let pollTimer;

        const cleanup = () => {
          if (pollTimer) {
            clearInterval(pollTimer);
            pollTimer = undefined;
          }

          clearTimeout(timeout);
          device.removeListener('rawData', onRawData);

          try {
            device.cancelLearn();
          } catch {
            // Best-effort cleanup.
          }
        };

        const finish = (err, result) => {
          if (complete) {
            return;
          }

          complete = true;
          cleanup();

          if (err) {
            reject(err);
          } else {
            resolve(result);
          }
        };

        const onRawData = (message) => {
          const code = message.toString('hex');
          logWith(this.log, 'info', 'Learned %s IR command (%d hex characters).', label, code.length);
          finish(null, code);
        };

        const timeout = setTimeout(() => {
          finish(new Error(`Timed out waiting for ${label} IR command.`));
        }, timeoutMs);

        device.on('rawData', onRawData);
        device.enterLearning();
        logWith(this.log, 'info', 'Broadlink learning mode is active for %s.', label);

        pollTimer = setInterval(() => {
          try {
            device.checkData();
          } catch (err) {
            finish(err);
          }
        }, 1000);

        delay(900)
          .then(() => {
            if (!complete) {
              device.checkData();
            }
          })
          .catch((err) => finish(err));
      });
    });
  }
}

BroadlinkClient.discoverBroadlinkDevice = discoverBroadlinkDevice;
BroadlinkClient.formatMac = formatMac;

module.exports = BroadlinkClient;
