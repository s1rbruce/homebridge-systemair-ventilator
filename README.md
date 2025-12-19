# Homebridge Systemair Ventilator Plugin

Homebridge plugin for controlling a **Systemair SAVE ventilator** via the **SAVEConnect WIFI module** and exposing it to **Apple HomeKit**.

The plugin communicates with the ventilator through the SAVEConnect web interface (HTTP API) and is designed to work correctly with **automatic airflow control (AUTO mode)**.

A SAVEConnect WIFI module is required, and you must know the IP address of the device.

---

## Installation

### 1) Install Homebridge

```bash
npm install -g homebridge
```
### 2) Install the plugin
```bash
npm install -g homebridge-systemair-ventilator-bruce
```
### 3) Configure the plugin
Edit your Homebridge config.json and add the accessory under "accessories":
 ```yaml
 {
  "accessory": "SystemairVentilatorBruce",
  "name": "Living Room Ventilator",
  "ip": "x.x.x.x"
}
```
Replace x.x.x.x with the actual IP address of your Systemair SAVEConnect device.

 ###  4) Restart Homebridge
   Restart Homebridge for the changes to take effect:

```bash
   sudo systemctl restart homebridge 
```

# Features:

Control the ventilator ON / OFF directly from HomeKit.

Control fan speed using the HomeKit percentage slider. Fan speed is mapped to discrete airflow levels used by the Systemair unit.

Provide a separate Refresh (Boost) button implemented as a momentary switch in HomeKit.

The Refresh button triggers the ventilator’s built-in Refresh / Boost mode without forcing a fixed fan speed and without modifying temperature.

The ventilator automatically returns to its previous operating state after the boost duration, fully managed by the unit itself.

The plugin is compatible with automatic airflow regulation (e.g. humidity-based AUTO mode) and does not override internal control logic.
