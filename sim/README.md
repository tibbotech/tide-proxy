# TPP simulator (Renode)

Runs Tibbo TPP boards (Zephyr firmware) in [Renode](https://renode.io), several at once, with a web UI.
You can see each device's LCD, LEDs and console, press its buttons, and reach it over the Tibbo UDP protocol (port 65535) from tide-proxy as if it were on the LAN.

| | G2 (tpp2g2, tpp3g2) | G3 (tpp2g3, tpp3g3) |
|---|---|---|
| MCU | STM32F207 (Cortex-M3) | STM32F439 (Cortex-M4F) |
| App base | 0x08008200 | 0x08040200 |
| DataFlash | AT45DB081E (264 B pages) | AT45DB321E (528 B pages) |

The simulator runs the **unmodified** `zephyr.elf` that you would flash to the board. Board-specific hardware is modelled in [renode/peripherals/TibboSim.cs](renode/peripherals/TibboSim.cs):

- **SSD1963 320×240 LCD** on the bit-banged 8080 bus (PE0-7, PC0/2/3/13, PB0), including address-mode flips and the panel mounting.
- **AT45 DataFlash** on SPI1 (CS PA15), file-backed. LittleFS/settings survive restarts.
- **AT24C16 EEPROM** on bit-banged I2C (PB8/PB9), file-backed. Each instance is seeded with its own MAC (`00:24:77:fe:00:NN`), which `udp_fwloader` reads at boot.
- **STM32 GPIO with open-drain, pulls and external drivers**, plus a SYSCFG/EXTICR multiplexer.
- **RMII PHY** at address 1, using Renode's Synopsys Ethernet MAC.
- **Buttons, LEDs, and the blue LED bar** (5-bit shift register on PA10-12).
- A boot stub at 0x08000000 that stands in for the Tibbo monitor, so resets and `EC` reboot work. Or the real monitor, see [Monitor](#monitor).

## Run

```sh
docker compose -f sim/docker/docker-compose.yml up -d --build
```

- **Web UI:** http://localhost:3100
- **tide-proxy relay:** udp://localhost:65530
- **Device web servers:** http://localhost:18001 … 18032 (instance *n* is on 18000+*n*)

Data lives in `sim/docker/sim-data/`: uploaded firmware, plus per-instance flash, EEPROM and config. Instances that were running come back when the container restarts.

Renode needs Linux TAP devices, so the container runs with `NET_ADMIN` and `/dev/net/tun`. This works on Docker Desktop (Windows/macOS) and on Linux.

## Use

1. **Upload firmware.** Upload `build/zephyr/zephyr.elf` and `build/zephyr/zephyr.dts` from a Zephyr build for a TPP board.
   - The DTS tells the simulator the board, the console UART, and the gpio-keys/gpio-leds to show. Without it, TPP defaults are used.
   - The generation (G2/G3) is detected from the ELF's flash address.
2. **Create instances.** Choose New instance, or Run next to a firmware. You can create several at once.
   - Each instance gets a MAC, a DHCP-reserved IP `10.77.0.(10+n)` on the simulated LAN, and its own flash/EEPROM.
3. **Open an instance** to see the LCD, LEDs, blue bar and console, and to press buttons.
   - The device is drawn as its faceplate ([manager/public/boards](manager/public/boards)): `tps3` for TPP3, `tps2l` (LCD and 4 keys) for a TPP2 build with a display, `tps2` otherwise. Its LEDs follow the simulated pins; the keys and the MD pinhole can be pressed.
   - Hold a button to keep it pressed; shift+click latches it.
   - The Renode log tab shows the emulator's own output.
   - **Console** defaults to **udp (debug print)**: the device's `log_udp` buffer, read with the same UDP commands TIDE uses (`PC` → `GM0000,02` → `GM0002,10`… → `PR`).
     - Reading dequeues entries, so the reader pauses while a tide-proxy client is fetching debug print through the relay. During that time it rebuilds the lines from the client's traffic, so nothing is lost on either side.
     - UARTs with a socket (for example the `zephyr,console` one) are in the same dropdown and accept typing.

The same actions are available over HTTP:

```sh
curl localhost:3100/api/instances
curl -X POST localhost:3100/api/instances/<id>/input -H 'Content-Type: application/json' \
     -d '{"button":"mdbutton","pressed":true}'
curl -X POST localhost:3100/api/instances/<id>/reset
curl localhost:3100/api/instances/<id>/screen.png -o screen.png
```

## Monitor

Set the real Tibbo Monitor/Loader for a generation under **Monitor** in the web UI (or `PUT /api/monitors/g2` with `{ "name", "bin": base64 }`). Use the plain image (for example `TPP2WG2_RELEASE_MON.bin`), not the encrypted `*_ENC.bin` update file: that one can't run and is rejected.

Instances of that generation started afterwards boot through the monitor, as a board does:

- Internal flash is a per-instance file, `flash.bin`: the monitor at 0x08000000, then the app from the firmware ELF in the layout the monitor installs (size header and checksum at app base − 0x200). The file is written back on every reset and on stop.
- Uploads through TIDE/tide-proxy work: `QF` makes the app set the boot signature and reboot, the monitor comes up as `TiOS-32 Loader`, takes the `D` blocks, flashes them and boots the new app. The upload is the same TiOS-format `.bin` (from `convert_to_tios.js`) that a board takes.
- An uploaded app stays across restarts. **Reflash** (`POST /api/instances/<id>/reflash`) reinstalls the app from the firmware ELF; switching the instance's firmware does the same. The instance keeps using that firmware's DTS for buttons, LEDs and UARTs.

Removing the monitor puts later starts back on the boot stub.

## tide-proxy

Start tide-proxy with the relay address:

```sh
TIDE_PROXY_SIM_RELAY=127.0.0.1:65530 node lib/server.js
```

Or pass `simRelay` in `TIDEProxyOptions`.

This adds a `renode-sim` interface. Discovery, `X`, state, buzz, reboot and other commands go to the relay, which broadcasts them on the simulated LAN. Device replies come back the same way. Simulated devices then appear next to real ones, with their own MACs. Select `renode-sim` as the interface to talk only to the simulator.

`TIDE_PROXY_SIM_URL` (default `http://localhost:3100`) is the link shown on the tide-proxy page.

## Limits

- **Without a monitor, firmware is loaded by the simulator,** by uploading an ELF or switching firmware on an instance. Uploading through TIDE/tide-proxy (`QF`/`D`/`N`) needs the real monitor ([Monitor](#monitor)).
- **Not modelled:** touch, the beeper (DAC/PWM), Wi-Fi (WA2000), and Tibbits other than plain GPIO.
- **Speed:** time runs at real time while firmware is mostly idle. A full-screen LCD redraw takes noticeably longer than on hardware, because every byte is bit-banged through GPIO.

## Layout

```
sim/
  docker/      Dockerfile (Renode 1.17 + sim-manager), entrypoint (bridge, DHCP), compose file
  renode/      tibbo_base.repl, tibbo_g2.repl, tibbo_g3.repl, peripherals/TibboSim.cs
  manager/     Node/TypeScript sim-manager: instances, UDP relay, REST + WebSocket, web UI (public/)
```

Renode 1.17 or newer is required. Earlier Synopsys Ethernet MAC models keep the ETH interrupt asserted while DMA interrupts are disabled, which hangs the G3 (STM32F4 HAL v2) Ethernet driver.
