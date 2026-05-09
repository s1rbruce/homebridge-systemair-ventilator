'use strict';

const axios = require('axios');
const http = require('http');

let Service, Characteristic;

module.exports = (homebridge) => {
  Service = homebridge.hap.Service;
  Characteristic = homebridge.hap.Characteristic;

  homebridge.registerAccessory(
    'homebridge-systemair-ventilator-bruce',
    'SystemairVentilatorBruce',
    SystemairVentilator
  );
};

class SystemairVentilator {
  constructor(log, config, api) {
    this.log = log;
    this.config = config || {};
    this.api = api;

    this.log('BRUCE DEBUG: loaded index.js v6 (polling 30s, cache-only onGet, sticky speed, serialized HTTP)');

    if (!this.config.ip) {
      this.log('BRUCE ERROR: Missing "ip" in config.json');
    }

    this.DEBUG = !!this.config.debug;

    // axios keep-alive, single socket to avoid parallel connections
    this.axiosInstance = axios.create({
      timeout: 20000,
      httpAgent: new http.Agent({
        keepAlive: true,
        maxSockets: 1,
      }),
      validateStatus: (s) => s >= 200 && s < 300,
    });

    // serialize requests
    this._q = Promise.resolve();

    // -----------------------------
    // Registers (ALL ARE "DOC - 1")
    // -----------------------------
    this.REG_FAN_MODE = this.getCfgInt('regFanMode', 1130); // doc 1131 -> 1130
    this.REG_USERMODE_REQ = this.getCfgInt('regUserModeReq', 1161); // doc 1162 -> 1161 (4=Refresh)
    this.REG_TIMER = this.getCfgInt('regTimer', 1110); // doc 1111 -> 1110

    // Sensors (read-only)
    this.REG_SUPPLY_TEMP = this.getCfgInt('regSupplyTemp', 12102); // doc 12103 -> 12102 (0.1C signed)
    this.REG_EXTRACT_RH = this.getCfgInt('regExtractRH', 12135); // doc 12136 -> 12135

    // Thermostat setpoint
    this.REG_SUPPLY_TEMP_SP = this.getCfgInt('regSupplyTempSetpoint', 2000); // doc 2001 -> 2000 (0.1C)

    // Scaling
    this.RH_SCALE = this.getCfgFloat('rhScale', 1); // if RH is in tenths, set 0.1

    // Thermostat range
    this.TEMP_MIN = this.getCfgFloat('tempMin', 12);
    this.TEMP_MAX = this.getCfgFloat('tempMax', 30);
    this.TEMP_STEP = this.getCfgFloat('tempStep', 1);

    // Cache / state (sticky speed pattern)
    this.cache = {
      active: 0,
      rotationSpeedPct: 25, // default low
      lastFanMode: 2,       // 2=low, 3=mid, 4=high
      timer: 0,
      supplyTempC: 20.0,
      rh: 50,
      targetTempC: 20.0,
    };

    // -----------------------------
    // Services
    // -----------------------------
    const baseName = this.config.name || 'Systemair';

    this.fanService = new Service.Fanv2(baseName + ' Fan');
    this.refreshService = new Service.Switch(baseName + ' Refresh');
    this.timerService = new Service.Battery(baseName + ' Timer');

    this.tempService = new Service.TemperatureSensor(baseName + ' Supply Air Temp');
    this.humidityService = new Service.HumiditySensor(baseName + ' Extract RH');

    this.thermostatService = new Service.Thermostat(baseName + ' Supply Temp Setpoint');

    this.setupCharacteristics();

    // -----------------------------
    // Polling (refresh every 30s by default)
    // -----------------------------
    this.POLL_MS = Number(this.config.pollMs) || 30000;
    this.log(`BRUCE: polling enabled every ${this.POLL_MS} ms`);

    setTimeout(() => {
      this.pollOnce().catch((e) => {
        this.log(`BRUCE initial poll error: ${e && e.message ? e.message : e}`);
      });
    }, 2000);

    this._pollTimer = setInterval(() => {
      this.pollOnce().catch((e) => {
        this.log(`BRUCE poll error: ${e && e.message ? e.message : e}`);
      });
    }, this.POLL_MS);
  }

  // -----------------------------
  // Config helpers
  // -----------------------------
  getCfgInt(key, def) {
    const v = this.config && this.config[key];
    const n = Number(v);
    return Number.isFinite(n) ? Math.trunc(n) : def;
  }

  getCfgFloat(key, def) {
    const v = this.config && this.config[key];
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  }

  clamp(n, min, max) {
    return Math.max(min, Math.min(max, n));
  }

  dbg(msg) {
    if (this.DEBUG) this.log(`[BRUCE] ${msg}`);
  }

  // -----------------------------
  // Queue helpers (serialize)
  // -----------------------------
  enqueue(fn) {
    const run = async () => fn();
    this._q = this._q.then(run, run);
    return this._q;
  }

  // -----------------------------
  // HTTP helpers
  // -----------------------------
  async retryRequest(url, retries = 3) {
    for (let i = 0; i < retries; i++) {
      try {
        return await this.axiosInstance.get(url);
      } catch (error) {
        if (i === retries - 1) throw error;
        await new Promise((resolve) => setTimeout(resolve, 350));
      }
    }
  }

  async readReg(regAddr) {
    const url = `http://${this.config.ip}/mread?{"${regAddr}":1}`;
    return this.enqueue(async () => {
      const response = await this.retryRequest(url);
      return response.data[String(regAddr)];
    });
  }

  async writeRegs(regMap) {
    const url = `http://${this.config.ip}/mwrite?${JSON.stringify(regMap)}`;
    return this.enqueue(async () => {
      await this.retryRequest(url);
      return true;
    });
  }

  async safeReadReg(regAddr, fallbackValue, label) {
    try {
      return await this.readReg(regAddr);
    } catch (e) {
      const code = e && e.code ? e.code : '';
      const msg = e && e.message ? e.message : String(e);
      this.log(`${label || 'Read'} failed reg=${regAddr} (${code} ${msg}). Using fallback.`);
      return fallbackValue;
    }
  }

  // -----------------------------
  // Value decoding/encoding
  // -----------------------------
  decodeTempTenthSigned(raw) {
    if (raw === null || raw === undefined) return 0;
    let n = Number(raw);
    if (!Number.isFinite(n)) return 0;
    if (n > 32767) n = n - 65536;
    return n / 10.0;
  }

  encodeTempTenth(tempC) {
    const t = Number(tempC);
    if (!Number.isFinite(t)) return 0;
    return Math.round(t * 10); // 18.0 => 180
  }

  // -----------------------------
  // Fan mode mapping helpers
  // -----------------------------
  modeToPct(mode) {
    if (mode === 2) return 25;
    if (mode === 3) return 45;
    if (mode === 4) return 70;
    return 0;
  }

  pctToMode(pct) {
    const p = Number(pct);
    if (!Number.isFinite(p)) return 2;
    if (p <= 34) return 2;
    if (p <= 57) return 3;
    return 4;
  }

  // -----------------------------
  // CACHE-ONLY onGet handlers (instant, no HTTP)
  // -----------------------------
  getActiveCached() {
    return this.cache.active ? 1 : 0;
  }

  getRotationSpeedCached() {
    const v = Number(this.cache.rotationSpeedPct);
    return Number.isFinite(v) ? v : 0;
  }

  getTimerCached() {
    const v = Number(this.cache.timer);
    return Number.isFinite(v) ? v : 0;
  }

  getSupplyAirTemperatureCached() {
    const v = Number(this.cache.supplyTempC);
    return Number.isFinite(v) ? v : 0;
  }

  getExtractRHCached() {
    const v = Number(this.cache.rh);
    return Number.isFinite(v) ? v : 0;
  }

  getSupplyAirTargetTemperatureCached() {
    const v = Number(this.cache.targetTempC);
    return Number.isFinite(v) ? v : 20;
  }

  // -----------------------------
  // Polling: refresh values and push to HomeKit
  // -----------------------------
  async pollOnce() {
    // Read actual values from device (HTTP is serialized)
    await this.refreshCacheFromDevice();

    // Push updates to HomeKit
    this.tempService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(this.cache.supplyTempC);
    this.humidityService.getCharacteristic(Characteristic.CurrentRelativeHumidity).updateValue(this.cache.rh);

    this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature).updateValue(this.cache.supplyTempC);
    this.thermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(this.cache.targetTempC);

    this.timerService.getCharacteristic(Characteristic.BatteryLevel).updateValue(this.cache.timer);

    this.fanService.getCharacteristic(Characteristic.Active).updateValue(this.cache.active ? 1 : 0);
    this.fanService.getCharacteristic(Characteristic.RotationSpeed).updateValue(this.cache.rotationSpeedPct);

    this.dbg(
      `POLL supply=${this.cache.supplyTempC.toFixed(1)}C rh=${Math.round(this.cache.rh)}% target=${this.cache.targetTempC.toFixed(1)}C timer=${this.cache.timer} active=${this.cache.active} rot=${this.cache.rotationSpeedPct}`
    );
  }

  async refreshCacheFromDevice() {
    // Supply temp
    const rawSupply = await this.safeReadReg(this.REG_SUPPLY_TEMP, null, 'SupplyAirTemp');
    if (rawSupply !== null && rawSupply !== undefined) {
      this.cache.supplyTempC = this.decodeTempTenthSigned(rawSupply);
    }

    // RH
    const rawRh = await this.safeReadReg(this.REG_EXTRACT_RH, null, 'ExtractRH');
    if (rawRh !== null && rawRh !== undefined) {
      let rh = Number(rawRh);
      if (!Number.isFinite(rh)) rh = this.cache.rh;
      rh = rh * this.RH_SCALE;
      this.cache.rh = this.clamp(rh, 0, 100);
    }

    // Target setpoint
    const rawSp = await this.safeReadReg(this.REG_SUPPLY_TEMP_SP, null, 'TargetTemp');
    if (rawSp !== null && rawSp !== undefined) {
      const t = this.decodeTempTenthSigned(rawSp);
      this.cache.targetTempC = this.clamp(t, this.TEMP_MIN, this.TEMP_MAX);
    }

    // Timer (BatteryLevel hack)
    const url = `http://${this.config.ip}/mread?{"${this.REG_TIMER}":2}`;
    try {
      const response = await this.enqueue(() => this.retryRequest(url));
      let timerValue = Number(response.data[String(this.REG_TIMER)]);
      if (!Number.isFinite(timerValue)) timerValue = this.cache.timer;
      if (timerValue < 0) timerValue = 0;
      if (timerValue > 100) timerValue = 100;
      this.cache.timer = timerValue;
    } catch (e) {
      const code = e && e.code ? e.code : '';
      const msg = e && e.message ? e.message : String(e);
      this.log(`Timer read failed (${code} ${msg}). Using cached=${this.cache.timer}`);
    }

    // Fan mode/state
    const rawMode = await this.safeReadReg(this.REG_FAN_MODE, null, 'FanMode');
    const mode = Number(rawMode);

    if (Number.isFinite(mode)) {
      if (mode === 0) {
        this.cache.active = 0;
        this.cache.rotationSpeedPct = 0;
      } else {
        // any non-zero -> running
        this.cache.active = 1;

        if (mode === 2 || mode === 3 || mode === 4) {
          this.cache.lastFanMode = mode;
          this.cache.rotationSpeedPct = this.modeToPct(mode);
        } else {
          // unknown non-zero: keep sticky speed (do NOT overwrite with 0)
          if (!this.cache.rotationSpeedPct || this.cache.rotationSpeedPct === 0) {
            this.cache.lastFanMode = 2;
            this.cache.rotationSpeedPct = 25;
          }
        }
      }
    }
  }

  // -----------------------------
  // Characteristics wiring (onGet is cache-only)
  // -----------------------------
  setupCharacteristics() {
    this.fanService
      .getCharacteristic(Characteristic.Active)
      .onSet(this.setActive.bind(this))
      .onGet(this.getActiveCached.bind(this));

    this.fanService
      .getCharacteristic(Characteristic.RotationSpeed)
      .onSet(this.setRotationSpeed.bind(this))
      .onGet(this.getRotationSpeedCached.bind(this));

    this.refreshService
      .getCharacteristic(Characteristic.On)
      .onSet(this.setRefresh.bind(this));

    this.timerService
      .getCharacteristic(Characteristic.BatteryLevel)
      .onGet(this.getTimerCached.bind(this));

    this.tempService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(this.getSupplyAirTemperatureCached.bind(this));

    this.humidityService
      .getCharacteristic(Characteristic.CurrentRelativeHumidity)
      .onGet(this.getExtractRHCached.bind(this));

    this.thermostatService
      .getCharacteristic(Characteristic.CurrentTemperature)
      .onGet(this.getSupplyAirTemperatureCached.bind(this));

    this.thermostatService
      .getCharacteristic(Characteristic.TargetTemperature)
      .setProps({
        minValue: this.TEMP_MIN,
        maxValue: this.TEMP_MAX,
        minStep: this.TEMP_STEP,
      })
      .onGet(this.getSupplyAirTargetTemperatureCached.bind(this))
      .onSet(this.setSupplyAirTargetTemperature.bind(this));

    this.thermostatService
      .getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onGet(async () => Characteristic.TargetHeatingCoolingState.AUTO)
      .onSet(async () => {});

    this.thermostatService
      .getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(async () => Characteristic.CurrentHeatingCoolingState.HEAT);
  }

  // -----------------------------
  // Fan: Active (ON/OFF) - sticky speed
  // IMPORTANT: never write "1" to fan mode register
  // -----------------------------
  async setActive(value) {
    const on = !!value;

    try {
      if (!on) {
        await this.writeRegs({ [this.REG_FAN_MODE]: 0 });
        this.cache.active = 0;
        this.cache.rotationSpeedPct = 0;

        this.fanService.getCharacteristic(Characteristic.Active).updateValue(0);
        this.fanService.getCharacteristic(Characteristic.RotationSpeed).updateValue(0);

        this.log(`SetActive: OFF -> reg=${this.REG_FAN_MODE} value=0`);
        return;
      }

      const mode =
        this.cache.lastFanMode === 2 || this.cache.lastFanMode === 3 || this.cache.lastFanMode === 4
          ? this.cache.lastFanMode
          : 2;

      await this.writeRegs({ [this.REG_FAN_MODE]: mode });

      this.cache.active = 1;
      this.cache.rotationSpeedPct = this.modeToPct(mode);

      this.fanService.getCharacteristic(Characteristic.Active).updateValue(1);
      this.fanService.getCharacteristic(Characteristic.RotationSpeed).updateValue(this.cache.rotationSpeedPct);

      this.log(`SetActive: ON -> reg=${this.REG_FAN_MODE} value=${mode}`);
    } catch (e) {
      const code = e && e.code ? e.code : '';
      const msg = e && e.message ? e.message : String(e);
      this.log(`SetActive failed (${code} ${msg})`);
    }
  }

  // -----------------------------
  // Fan: RotationSpeed (sticky speed)
  // Treat RotationSpeed=0 while Active=1 as "keep last"
  // -----------------------------
  async setRotationSpeed(value) {
    const pct = Number(value);

    try {
      // HomeKit sometimes sends 0 right after turning on -> do NOT turn off
      if ((pct === 0 || !Number.isFinite(pct)) && this.cache.active === 1) {
        const keep =
          this.cache.lastFanMode === 2 || this.cache.lastFanMode === 3 || this.cache.lastFanMode === 4
            ? this.cache.lastFanMode
            : 2;

        await this.writeRegs({ [this.REG_FAN_MODE]: keep });

        this.cache.active = 1;
        this.cache.rotationSpeedPct = this.modeToPct(keep);

        this.fanService.getCharacteristic(Characteristic.Active).updateValue(1);
        this.fanService.getCharacteristic(Characteristic.RotationSpeed).updateValue(this.cache.rotationSpeedPct);

        this.log(`SetRotationSpeed: HK sent 0 but Active=1 -> keep mode=${keep}`);
        return;
      }

      if (pct === 0) {
        await this.writeRegs({ [this.REG_FAN_MODE]: 0 });

        this.cache.active = 0;
        this.cache.rotationSpeedPct = 0;

        this.fanService.getCharacteristic(Characteristic.Active).updateValue(0);
        this.fanService.getCharacteristic(Characteristic.RotationSpeed).updateValue(0);

        this.log(`SetRotationSpeed: OFF -> reg=${this.REG_FAN_MODE} mode=0`);
        return;
      }

      const mode = this.pctToMode(pct);
      await this.writeRegs({ [this.REG_FAN_MODE]: mode });

      this.cache.active = 1;
      this.cache.lastFanMode = mode;
      this.cache.rotationSpeedPct = this.modeToPct(mode);

      this.fanService.getCharacteristic(Characteristic.Active).updateValue(1);
      this.fanService.getCharacteristic(Characteristic.RotationSpeed).updateValue(this.cache.rotationSpeedPct);

      this.log(`SetRotationSpeed: reg=${this.REG_FAN_MODE} mode=${mode} (${this.cache.rotationSpeedPct}%)`);
    } catch (e) {
      const code = e && e.code ? e.code : '';
      const msg = e && e.message ? e.message : String(e);
      this.log(`SetRotationSpeed failed (${code} ${msg})`);
    }
  }

  // -----------------------------
  // Thermostat: Target setpoint (write)
  // -----------------------------
  async setSupplyAirTargetTemperature(value) {
    const t = this.clamp(Number(value), this.TEMP_MIN, this.TEMP_MAX);
    const raw = this.encodeTempTenth(t);

    try {
      await this.writeRegs({ [this.REG_SUPPLY_TEMP_SP]: raw });
      this.cache.targetTempC = t;

      this.thermostatService.getCharacteristic(Characteristic.TargetTemperature).updateValue(t);

      this.log(`SetTargetTemp: reg=${this.REG_SUPPLY_TEMP_SP} valueRaw=${raw} (${t.toFixed(1)}C)`);
    } catch (e) {
      const code = e && e.code ? e.code : '';
      const msg = e && e.message ? e.message : String(e);
      this.log(`SetTargetTemp failed (${code} ${msg})`);
    }
  }

  // -----------------------------
  // Refresh (momentary)
  // user mode request = 4
  // -----------------------------
  async setRefresh(value) {
    if (!value) return;

    try {
      await this.writeRegs({ [this.REG_USERMODE_REQ]: 4 });
      this.log(`Refresh: reg=${this.REG_USERMODE_REQ} value=4`);
    } catch (e) {
      const code = e && e.code ? e.code : '';
      const msg = e && e.message ? e.message : String(e);
      this.log(`Refresh failed (${code} ${msg})`);
    } finally {
      setTimeout(() => {
        this.refreshService.getCharacteristic(Characteristic.On).updateValue(false);
      }, 800);
    }
  }

  // -----------------------------
  // Export services
  // -----------------------------
  getServices() {
    return [
      this.fanService,
      this.refreshService,
      this.timerService,
      this.tempService,
      this.humidityService,
      this.thermostatService,
    ];
  }
}

/*
Example config.json (ALL reg values are "DOC - 1"):

{
  "accessory": "SystemairVentilatorBruce",
  "name": "Systemair",
  "ip": "192.168.1.50",

  "debug": false,
  "pollMs": 30000,

  "regFanMode": 1130,
  "regUserModeReq": 1161,
  "regTimer": 1110,

  "regSupplyTemp": 12102,
  "regExtractRH": 12135,
  "regSupplyTempSetpoint": 2000,

  "rhScale": 1,

  "tempMin": 12,
  "tempMax": 30,
  "tempStep": 1
}

Notes:
- onGet handlers are cache-only to eliminate HomeKit "!" blink on detail open
- polling refreshes cache and pushes values every pollMs (default 30s)
- sticky speed prevents RotationSpeed=0 glitch after Active=1
- Active never writes invalid value "1" into the mode register
- HTTP is serialized + keepAlive to reduce ECONNRESET
*/
