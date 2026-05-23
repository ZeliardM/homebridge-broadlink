# Homebridge Broadlink Fireplace

Local-only Homebridge plugin for one fireplace controlled by:

- one Broadlink IR blaster, addressed by IP
- two learned IR commands: Power and Heat
- one IKEA DIRIGERA outlet used as the real power control

The plugin exposes four HomeKit controls:

- Fireplace Power
- Fireplace Heat Low
- Fireplace Heat High
- Fireplace Heat Off

The raw IR commands, outlet state, started state, awake window, and heat state are handled inside the plugin.

## Setup

Use the Homebridge custom UI.

1. Enter the fireplace name and Broadlink IP address.
2. Click `Connect Broadlink`.
3. Learn the `Power` IR command.
4. Learn the `Heat` IR command.
5. Enter the DIRIGERA gateway IP.
6. Pair DIRIGERA.
7. Import the outlet that powers the fireplace.
8. Save the Homebridge config.

## Behavior

Turning Fireplace Power on turns on the DIRIGERA outlet, waits 4 seconds, sends the IR Power command, sets heat to Off, and tracks the fireplace as awake for 4 seconds.

Turning Fireplace Power off turns off the DIRIGERA outlet, resets all internal state, and shows all heat switches as off. It does not send IR Power.

Heat requests always ensure the outlet is on and the fireplace has been started. Heat is tracked as a three-state cycle:

```text
Off -> Low -> High -> Off
```

If the fireplace is outside the awake window, the plugin sends one Heat command as a wake-up press, waits 750 ms, then sends the real Heat presses needed to reach the requested mode.
