;(function () {
  const PLUGIN_NAME = 'homebridge-broadlink';
  const PLATFORM_NAME = 'BroadlinkPlatform';
  const QUALIFIED_PLATFORM_NAME = `${PLUGIN_NAME}.${PLATFORM_NAME}`;
  const PLATFORM_ALIASES = new Set([
    PLATFORM_NAME,
    QUALIFIED_PLATFORM_NAME,
    'homebridge-broadlink.BroadlinkPlatform',
  ]);

  const COMMANDS = [
    { key: 'powerCode', label: 'Power' },
    { key: 'heatCode', label: 'Heat' },
  ];

  const NUMERIC_FIELDS = new Set([
    'startupDelayMs',
    'awakeDurationMs',
    'wakeDelayMs',
    'heatPressDelayMs',
  ]);

  const app = document.getElementById('app');
  const hb = window.homebridge;
  const state = {
    pluginConfig: [],
    platformConfig: null,
    device: null,
    updateTimer: null,
    modal: null,
    outlets: [],
  };

  function escapeHtml(value) {
    return String(value ?? '')
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function getFieldValue(field) {
    const value = state.device?.[field];
    return value === undefined || value === null ? '' : String(value);
  }

  function setDefaultDeviceFields(device) {
    device.name = device.name || 'Fireplace';
    device.startupDelayMs = device.startupDelayMs ?? 4000;
    device.awakeDurationMs = device.awakeDurationMs ?? 4000;
    device.wakeDelayMs = device.wakeDelayMs ?? 750;
    device.heatPressDelayMs = device.heatPressDelayMs ?? 750;
  }

  function ensurePlatformConfig(pluginConfig) {
    const blocks = Array.isArray(pluginConfig) ? pluginConfig : [];
    let platformConfig = blocks.find((block) => PLATFORM_ALIASES.has(block.platform));

    if (!platformConfig) {
      platformConfig = {
        platform: QUALIFIED_PLATFORM_NAME,
        name: PLATFORM_NAME,
        device: {},
      };
      blocks.push(platformConfig);
    }

    platformConfig.platform = QUALIFIED_PLATFORM_NAME;
    platformConfig.name = platformConfig.name || PLATFORM_NAME;
    platformConfig.device = platformConfig.device && typeof platformConfig.device === 'object'
      ? platformConfig.device
      : {};

    delete platformConfig.hosts;
    delete platformConfig.accessories;
    delete platformConfig.hideLearnButton;
    delete platformConfig.hideScanFrequencyButton;

    setDefaultDeviceFields(platformConfig.device);
    state.pluginConfig = blocks;
    state.platformConfig = platformConfig;
    state.device = platformConfig.device;
  }

  function fieldHtml(field, label, options = {}) {
    const required = options.required === true;
    const type = options.type || 'text';
    const note = options.note ? `<div class="field-note">${escapeHtml(options.note)}</div>` : '';

    return `
      <div class="${options.wide ? 'wide' : ''}">
        <label class="form-label" for="${field}">
          ${escapeHtml(label)}${required ? '<span class="required-mark">*</span>' : ''}
        </label>
        <input
          id="${field}"
          class="form-control"
          data-field="${field}"
          type="${type}"
          value="${escapeHtml(getFieldValue(field))}"
          autocomplete="${type === 'password' ? 'new-password' : 'off'}"
        />
        ${note}
      </div>
    `;
  }

  function readonlyFieldHtml(label, value, options = {}) {
    if (!value && options.hideEmpty !== false) {
      return '';
    }

    return `
      <div class="${options.wide ? 'wide' : ''}">
        <label class="form-label">${escapeHtml(label)}</label>
        <input
          class="form-control ${options.secret ? 'secret-value' : ''}"
          type="${options.type || 'text'}"
          value="${escapeHtml(options.displayValue || value)}"
          readonly
        />
        ${options.note ? `<div class="field-note">${escapeHtml(options.note)}</div>` : ''}
      </div>
    `;
  }

  function isBroadlinkReady() {
    return Boolean(getFieldValue('ip').trim());
  }

  function isDirigeraReady() {
    return Boolean(getFieldValue('dirigeraGatewayIP').trim() && getFieldValue('dirigeraAccessToken').trim());
  }

  function truncateMiddle(value, head = 12, tail = 8) {
    const text = String(value || '');
    if (text.length <= head + tail + 3) {
      return text;
    }

    return `${text.slice(0, head)}...${text.slice(-tail)}`;
  }

  function render() {
    app.innerHTML = `
      <div class="ui-shell">
        <div class="topbar">
          <div>
            <h2>Fireplace Broadlink Setup</h2>
            <p>One IR blaster, two IR commands, and one DIRIGERA outlet.</p>
          </div>
          <button type="button" class="btn btn-outline-primary" data-action="connect-broadlink" ${isBroadlinkReady() ? '' : 'disabled'}>
            Connect Broadlink
          </button>
        </div>
        ${renderDevicePanel()}
        ${renderIrPanel()}
        ${renderDirigeraPanel()}
        ${renderTimingPanel()}
      </div>
    `;
  }

  function renderDevicePanel() {
    const deviceType = getFieldValue('deviceType');
    const deviceTypeDisplay = deviceType ? `0x${Number(deviceType).toString(16)}` : '';

    return `
      <section class="panel">
        <div class="section-heading">
          <span class="section-number">1</span>
          <div>
            <h3>Fireplace Device</h3>
            <p>Name the HomeKit accessory and point it at the Broadlink blaster.</p>
          </div>
        </div>
        <div class="field-grid">
          ${fieldHtml('name', 'Name', { required: true, wide: true })}
          ${fieldHtml('ip', 'Broadlink IP Address', { required: true })}
          ${readonlyFieldHtml('Broadlink Model', getFieldValue('model'))}
          ${readonlyFieldHtml('Broadlink MAC', getFieldValue('mac'))}
          ${readonlyFieldHtml('Broadlink Device Type', deviceTypeDisplay)}
        </div>
      </section>
    `;
  }

  function renderIrPanel() {
    const ready = isBroadlinkReady();
    const learned = COMMANDS.filter((command) => getFieldValue(command.key));

    return `
      <section class="panel">
        <div class="section-heading section-heading-action">
          <span class="section-number">2</span>
          <div>
            <h3>IR Commands</h3>
            <p>Learn Power and Heat from the fireplace remote.</p>
          </div>
          <button type="button" class="btn btn-primary" data-action="open-learn-modal" ${ready ? '' : 'disabled'}>
            Learn IR Code
          </button>
        </div>

        <div class="setup-status">
          <div>
            <strong>${ready ? 'Ready to learn IR commands.' : 'Enter the Broadlink IP first.'}</strong>
            <p class="inline-note">${learned.length}/2 commands learned.</p>
          </div>
          <span class="status-pill ${ready ? 'ready' : 'blocked'}">${ready ? 'Ready' : 'Locked'}</span>
        </div>

        ${
          learned.length
            ? `<div class="learned-list">${learned.map(renderLearnedCommand).join('')}</div>`
            : '<div class="empty-state">No IR codes have been learned yet.</div>'
        }
      </section>
    `;
  }

  function renderLearnedCommand(command) {
    return `
      <div class="learned-command">
        <div>
          <label>${escapeHtml(command.label)}</label>
          <input class="form-control secret-value" type="text" value="${escapeHtml(getFieldValue(command.key))}" readonly />
        </div>
        <div class="learned-actions">
          <button type="button" class="btn btn-outline-primary" data-action="test-ir" data-code-key="${command.key}">Test</button>
          <button type="button" class="btn btn-outline-danger" data-action="clear-ir" data-code-key="${command.key}">Clear</button>
        </div>
      </div>
    `;
  }

  function renderDirigeraPanel() {
    const gatewayIP = getFieldValue('dirigeraGatewayIP').trim();
    const token = getFieldValue('dirigeraAccessToken').trim();
    const outletId = getFieldValue('dirigeraOutletId').trim();
    const outletName = getFieldValue('dirigeraOutletName').trim();
    const outletDisplay = outletName && outletName !== outletId ? `${outletName} (${outletId})` : outletId;

    return `
      <section class="panel">
        <div class="section-heading">
          <span class="section-number">3</span>
          <div>
            <h3>DIRIGERA Outlet</h3>
            <p>The outlet backs Fireplace Power and stays internal to this plugin.</p>
          </div>
        </div>

        <div class="field-grid">
          ${fieldHtml('dirigeraGatewayIP', 'DIRIGERA Gateway IP', { required: true, wide: true })}
          ${
            token
              ? readonlyFieldHtml('DIRIGERA Access Token', token, {
                  type: 'password',
                  secret: true,
                  note: `Stored token: ${truncateMiddle(token)}`,
                })
              : ''
          }
          ${outletId ? readonlyFieldHtml('DIRIGERA Outlet', outletDisplay, { wide: true }) : ''}
        </div>
        <div class="button-row">
          <button id="pair-dirigera-button" type="button" class="btn btn-primary" data-action="open-dirigera-auth" ${gatewayIP ? '' : 'disabled'}>
            Pair DIRIGERA
          </button>
          <button id="find-dirigera-button" type="button" class="btn btn-outline-primary" data-action="find-dirigera-outlets" ${gatewayIP && token ? '' : 'disabled'}>
            Find Outlets
          </button>
          ${token ? '<button type="button" class="btn btn-outline-danger" data-action="clear-dirigera">Clear DIRIGERA</button>' : ''}
        </div>
      </section>
    `;
  }

  function renderTimingPanel() {
    return `
      <section class="panel">
        <div class="section-heading">
          <span class="section-number">4</span>
          <div>
            <h3>Timing</h3>
            <p>Defaults use the 4 second awake window and 750 ms wake delay.</p>
          </div>
        </div>
        <div class="field-grid">
          ${fieldHtml('startupDelayMs', 'Outlet Startup Delay (ms)', { type: 'number' })}
          ${fieldHtml('awakeDurationMs', 'Awake Window (ms)', { type: 'number' })}
          ${fieldHtml('wakeDelayMs', 'Wake Delay (ms)', { type: 'number' })}
          ${fieldHtml('heatPressDelayMs', 'Heat Press Delay (ms)', { type: 'number' })}
        </div>
      </section>
    `;
  }

  function notify(type, message, title) {
    if (hb?.toast?.[type]) {
      hb.toast[type](message, title);
    }
  }

  function getErrorMessage(err) {
    if (!err) {
      return 'Unknown error';
    }
    if (typeof err === 'string') {
      return err;
    }
    if (err.message) {
      return err.message;
    }
    if (err.error) {
      return err.error;
    }

    return JSON.stringify(err);
  }

  function parseConfigValue(field, value, type = '') {
    const text = String(value ?? '').trim();
    if (!text) {
      return { hasValue: false };
    }

    if (type === 'number' || NUMERIC_FIELDS.has(field)) {
      const number = Number(text);
      if (!Number.isFinite(number)) {
        return { hasValue: false };
      }

      return { hasValue: true, value: number };
    }

    return { hasValue: true, value: text };
  }

  function cloneDeviceForSave() {
    const clone = { ...state.device };

    Object.keys(clone).forEach((key) => {
      if (clone[key] === '') {
        delete clone[key];
        return;
      }

      if (!NUMERIC_FIELDS.has(key)) {
        return;
      }

      const parsed = parseConfigValue(key, clone[key], 'number');
      if (parsed.hasValue) {
        clone[key] = parsed.value;
      } else {
        delete clone[key];
      }
    });

    return clone;
  }

  function getSanitizedPluginConfig() {
    return state.pluginConfig.map((block) => {
      if (block !== state.platformConfig) {
        return block;
      }

      return {
        platform: QUALIFIED_PLATFORM_NAME,
        name: state.platformConfig.name || PLATFORM_NAME,
        device: cloneDeviceForSave(),
      };
    });
  }

  function scheduleUpdate() {
    clearTimeout(state.updateTimer);
    state.updateTimer = setTimeout(() => {
      updateConfig().catch((err) => notify('error', getErrorMessage(err), 'Config Update Failed'));
    }, 300);
  }

  async function flushUpdate() {
    clearTimeout(state.updateTimer);
    await updateConfig();
  }

  async function updateConfig() {
    await hb.updatePluginConfig(getSanitizedPluginConfig());
  }

  function requestDevice() {
    return cloneDeviceForSave();
  }

  function openModal(title, body, footer) {
    closeModal();

    const modal = document.createElement('div');
    modal.className = 'modal-backdrop-custom';
    modal.innerHTML = `
      <div class="modal-panel" role="dialog" aria-modal="true" aria-label="${escapeHtml(title)}">
        <div class="modal-header-custom">
          <h4>${escapeHtml(title)}</h4>
          <button type="button" class="btn-close" aria-label="Close" data-action="close-modal"></button>
        </div>
        <div class="modal-body-custom">
          ${body}
          ${footer || '<div class="button-row"><button type="button" class="btn btn-secondary" data-action="close-modal">Close</button></div>'}
        </div>
      </div>
    `;

    document.body.appendChild(modal);
    state.modal = modal;
  }

  function closeModal() {
    state.modal?.remove();
    state.modal = null;
  }

  function loadingHtml(message) {
    return `
      <div class="spinner-inline">
        <span class="spinner-border spinner-border-sm" role="status"></span>
        <span>${escapeHtml(message)}</span>
      </div>
    `;
  }

  async function connectBroadlink() {
    openModal('Connecting Broadlink', loadingHtml('Resolving and authenticating the Broadlink device...'), '');

    try {
      await flushUpdate();
      const result = await hb.request('/broadlink-connect', { device: requestDevice() });
      state.device.mac = result.mac;
      state.device.deviceType = result.deviceType;
      state.device.model = result.model;
      await updateConfig();
      notify('success', `${result.model} is staged. Use the Homebridge Save button to write it.`, 'Broadlink Connected');
      closeModal();
      render();
    } catch (err) {
      openModal('Could Not Connect Broadlink', `<p>${escapeHtml(getErrorMessage(err))}</p>`);
    }
  }

  function openLearnModal() {
    if (!isBroadlinkReady()) {
      return;
    }

    openModal(
      'Learn IR Code',
      `
        <div class="choice-grid">
          ${COMMANDS.map(
            (command) => `
              <button type="button" class="choice-button" data-action="learn-ir" data-code-key="${command.key}">
                <span class="choice-title">${escapeHtml(command.label)}</span>
                <span class="choice-meta">Press this button on the physical remote when learning starts.</span>
              </button>
            `,
          ).join('')}
        </div>
      `,
    );
  }

  async function learnIr(codeKey) {
    const command = COMMANDS.find((item) => item.key === codeKey);
    if (!command) {
      return;
    }

    openModal(
      `Learn ${command.label}`,
      `
        ${loadingHtml(`Listening for ${command.label}. Press the physical remote button now.`)}
        <p class="inline-note mt-3">This can take up to 30 seconds.</p>
      `,
      '',
    );

    try {
      await flushUpdate();
      const result = await hb.request('/learn-ir', {
        device: requestDevice(),
        codeKey,
      });

      state.device[result.codeKey] = result.code;
      await updateConfig();
      notify('success', `${result.label} is staged. Use the Homebridge Save button to write it.`, 'IR Code Learned');
      closeModal();
      render();
    } catch (err) {
      openModal(
        `Could Not Learn ${command.label}`,
        `<p>${escapeHtml(getErrorMessage(err))}</p>`,
        `<div class="button-row">
          <button type="button" class="btn btn-primary" data-action="open-learn-modal">Try Again</button>
          <button type="button" class="btn btn-secondary" data-action="close-modal">Close</button>
        </div>`,
      );
    }
  }

  async function testIr(codeKey) {
    const command = COMMANDS.find((item) => item.key === codeKey);
    if (!command) {
      return;
    }

    openModal(`Testing ${command.label}`, loadingHtml('Sending IR command...'), '');

    try {
      await flushUpdate();
      await hb.request('/send-ir', {
        device: requestDevice(),
        codeKey,
        code: state.device[codeKey],
      });
      notify('success', `${command.label} was sent.`, 'IR Test Sent');
      closeModal();
    } catch (err) {
      openModal(`Could Not Test ${command.label}`, `<p>${escapeHtml(getErrorMessage(err))}</p>`);
    }
  }

  async function clearIr(codeKey) {
    const command = COMMANDS.find((item) => item.key === codeKey);
    if (!command) {
      return;
    }

    state.device[codeKey] = '';
    await updateConfig();
    notify('success', `${command.label} is cleared. Use the Homebridge Save button to write it.`, 'IR Code Cleared');
    render();
  }

  function openDirigeraAuthModal() {
    openModal(
      'Pair DIRIGERA',
      `
        <p>Press the Action Button on the bottom of the DIRIGERA gateway within 60 seconds after starting pairing.</p>
      `,
      `<div class="button-row">
        <button type="button" class="btn btn-primary" data-action="start-dirigera-auth">Start Pairing</button>
        <button type="button" class="btn btn-secondary" data-action="close-modal">Cancel</button>
      </div>`,
    );
  }

  async function startDirigeraAuth() {
    const gatewayIP = getFieldValue('dirigeraGatewayIP').trim();
    if (!gatewayIP) {
      return;
    }

    openModal('Pairing DIRIGERA', loadingHtml('Waiting for the gateway button press...'), '');

    try {
      const result = await hb.request('/dirigera-authenticate', { gatewayIP });
      state.device.dirigeraAccessToken = result.accessToken;
      await updateConfig();
      notify('success', 'DIRIGERA access token is staged. Use the Homebridge Save button to write it.', 'Gateway Paired');
      await findDirigeraOutlets();
    } catch (err) {
      openModal(
        'DIRIGERA Pairing Failed',
        `<p>${escapeHtml(getErrorMessage(err))}</p>`,
        `<div class="button-row">
          <button type="button" class="btn btn-primary" data-action="open-dirigera-auth">Try Again</button>
          <button type="button" class="btn btn-secondary" data-action="close-modal">Close</button>
        </div>`,
      );
    }
  }

  async function findDirigeraOutlets() {
    if (!isDirigeraReady()) {
      return;
    }

    openModal('Finding Outlets', loadingHtml('Reading outlets from DIRIGERA...'), '');

    try {
      state.outlets = await hb.request('/dirigera-outlets', {
        gatewayIP: getFieldValue('dirigeraGatewayIP').trim(),
        accessToken: getFieldValue('dirigeraAccessToken').trim(),
      });

      openModal(
        'Choose Outlet',
        state.outlets.length
          ? `<div class="choice-grid">${state.outlets.map(renderOutletChoice).join('')}</div>`
          : '<div class="empty-state">No DIRIGERA outlets were found.</div>',
      );
    } catch (err) {
      openModal('Could Not Find Outlets', `<p>${escapeHtml(getErrorMessage(err))}</p>`);
    }
  }

  function renderOutletChoice(outlet, index) {
    const stateLabel = outlet.isOn ? 'On' : 'Off';
    const reachability = outlet.isReachable ? 'Reachable' : 'Not reachable';
    const meta = [outlet.roomName, outlet.model, stateLabel, reachability].filter(Boolean).join(' | ');

    return `
      <button type="button" class="choice-button" data-action="select-outlet" data-outlet-index="${index}">
        <span class="choice-title">${escapeHtml(outlet.name || outlet.id)}</span>
        <span class="choice-meta">${escapeHtml(meta)}</span>
        <span class="choice-meta">${escapeHtml(outlet.id)}</span>
      </button>
    `;
  }

  async function selectOutlet(index) {
    const outlet = state.outlets[index];
    if (!outlet) {
      return;
    }

    state.device.dirigeraOutletId = outlet.id;
    state.device.dirigeraOutletName = outlet.name || outlet.id;
    await updateConfig();
    notify('success', `${outlet.name || outlet.id} is staged. Use the Homebridge Save button to write it.`, 'Outlet Stored');
    closeModal();
    render();
  }

  async function clearDirigera() {
    delete state.device.dirigeraAccessToken;
    delete state.device.dirigeraOutletId;
    delete state.device.dirigeraOutletName;
    await updateConfig();
    notify('success', 'DIRIGERA details are cleared. Use the Homebridge Save button to write it.', 'DIRIGERA Cleared');
    render();
  }

  function setField(target) {
    const field = target.getAttribute('data-field');
    if (!field) {
      return;
    }

    const parsed = parseConfigValue(field, target.value, target.type);

    if (parsed.hasValue) {
      state.device[field] = parsed.value;
    } else {
      state.device[field] = '';
    }

    scheduleUpdate();
  }

  function handleClick(event) {
    const actionTarget = event.target.closest('[data-action]');
    if (!actionTarget || actionTarget.disabled) {
      if (event.target.classList.contains('modal-backdrop-custom')) {
        closeModal();
      }
      return;
    }

    const action = actionTarget.getAttribute('data-action');
    const codeKey = actionTarget.getAttribute('data-code-key');

    switch (action) {
      case 'close-modal':
        closeModal();
        break;
      case 'connect-broadlink':
        connectBroadlink();
        break;
      case 'open-learn-modal':
        openLearnModal();
        break;
      case 'learn-ir':
        learnIr(codeKey);
        break;
      case 'test-ir':
        testIr(codeKey);
        break;
      case 'clear-ir':
        clearIr(codeKey).catch((err) => notify('error', getErrorMessage(err), 'Clear Failed'));
        break;
      case 'open-dirigera-auth':
        openDirigeraAuthModal();
        break;
      case 'start-dirigera-auth':
        startDirigeraAuth();
        break;
      case 'find-dirigera-outlets':
        findDirigeraOutlets();
        break;
      case 'select-outlet':
        selectOutlet(Number(actionTarget.getAttribute('data-outlet-index'))).catch((err) =>
          notify('error', getErrorMessage(err), 'Outlet Save Failed'),
        );
        break;
      case 'clear-dirigera':
        clearDirigera().catch((err) => notify('error', getErrorMessage(err), 'Clear Failed'));
        break;
    }
  }

  async function init() {
    if (!hb) {
      app.innerHTML = '<div class="panel">The Homebridge custom UI API is not available in this window.</div>';
      return;
    }

    try {
      const pluginConfig = await hb.getPluginConfig();
      ensurePlatformConfig(pluginConfig);
      render();
    } catch (err) {
      app.innerHTML = `<div class="panel">${escapeHtml(getErrorMessage(err))}</div>`;
    }
  }

  app.addEventListener('input', (event) => {
    if (event.target?.matches?.('[data-field]')) {
      setField(event.target);
    }
  });
  app.addEventListener('change', (event) => {
    if (event.target?.matches?.('[data-field]')) {
      setField(event.target);
      render();
    }
  });
  document.addEventListener('click', handleClick);

  init();
})();
