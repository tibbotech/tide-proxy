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

Data lives in `sim/docker/sim-data/instances/<id>/`: each instance's config, firmware, flash and EEPROM. Instances that were running come back when the container restarts.

Renode needs Linux TAP devices, so the container runs with `NET_ADMIN` and `/dev/net/tun`. This works on Docker Desktop (Windows/macOS) and on Linux.

## Use

1. **Create instances.** Drag a board from the **Catalog** onto a DIN rail (its **+** adds one at the end of the first rail with room; its upload icon opens the dialog with firmware files), or choose **New device**. The devices: **TPP2G2** or **TPP3G2** (STM32F207), **TPP2G3** or **TPP3G3** (STM32F439). You can create several at once.
   - Each instance gets a MAC, a DHCP-reserved IP `10.77.0.(10+n)` on the simulated LAN, and its own flash/EEPROM.
   - Optionally pick files in the same dialog, as for an upload (below); each instance gets its own copy.
   - The faceplate follows the device (TPP3: `tps3`). Without a DTS, the TPP defaults for it are used; only TPP2 gets the LCD.
   - Without an app, an instance boots into its monitor's Loader, ready for an upload from TIDE ([Monitor](#monitor)). With no monitor either, it is created stopped until it gets one or an app.
2. **Upload firmware to an instance** with **Upload firmware** in the inspector (a device with nothing to boot says *no firmware* on its nameplate). Pick any of these together; they are told apart by extension:
   - **`.elf`**: the app, e.g. `build/zephyr/zephyr.elf` from a Zephyr build for that board.
   - **`.dts`**: its devicetree, `build/zephyr/zephyr.dts`.
   - **`.bin`**: raw bytes written into the instance's flash at the address you give (hex, default 0x08000000), as a programmer would. The address field suggests the usual places:

     | | G2 | G3 |
     |---|---|---|
     | Monitor/bootloader | 0x08000000 | 0x08000000 |
     | App image with TiOS header | 0x08008000 | 0x08040000 |
     | App | 0x08008200 | 0x08040200 |

     - At 0x08000000 the `.bin` must be a plain image starting with a vector table, such as `TPP2WG2_RELEASE_MON.bin` (the encrypted `*_ENC.bin` is rejected). Anything written into the monitor area replaces the default monitor for this instance; **Use default** in Properties brings the default back.
     - A `.bin` in the app area stays until a new `.elf` is uploaded or the app is reflashed, like an app uploaded from TIDE. `.bin` data the new app doesn't cover (a data image near the end of flash, say) is written back after it.
     - The writes are listed in Properties under **Flash .bin**. A `.bin` must fit in the generation's flash (1 MB for G2, 2 MB for G3).
   - The ELF must be linked for the instance's generation (detected from its flash address), and a DTS whose `compatible` names a TPP board must name the instance's (a `tpp3g2` DTS is rejected on a `tpp2g2` instance).
   - The DTS tells the simulator the board, the console UART, and the gpio-keys/gpio-leds to show. Leave it out to keep the instance's current DTS (handy when rebuilding the same project). An instance that never got one uses the TPP defaults.
   - A running instance restarts. API: `PUT /api/instances/<id>/firmware` with `{ elf?: base64, elfName?, dts?: text, bin?: base64, binName?, binAddress?: "0x08008000" | number }`; `POST /api/instances` takes `{ board: 'tpp2g2'|'tpp3g2'|'tpp2g3'|'tpp3g3', name?, count?, index?, ...the same files }` (`index`, with one instance, picks its number *n*, so its MAC, IP and ports are known in advance; it must be free); `DELETE /api/instances/<id>/monitor` goes back to the default monitor.
3. **Select a device** on the rail (or in the Devices list) to open the inspector below it: **Properties**, **Console**, **IO**, **Renode log** and **Wires**. The device itself shows its LCD, LEDs and blue bar, and its keys can be pressed.
   - The device is drawn as its faceplate ([manager/web/src/assets/boards](manager/web/src/assets/boards)): `tps3` for a TPP3 instance, `tps2l` (LCD and 4 keys) for a TPP2 build with a display, `tps2` otherwise. Its LEDs follow the simulated pins; the keys and the MD pinhole can be pressed.
   - Hold a button to keep it pressed; shift+click latches it.
   - The Renode log tab shows the emulator's own output.
   - The **IO** tab shows every GPIO port (PA-PI) live: level, mode (output, alternate function number, analog), and whether something outside the MCU (a button, a wire, the EEPROM, you) drives the line. Pins the board or the DTS uses are outlined and listed below with a 10 s trace; **Watch** adds any other pin to the list. Select a pin to drive it high or low, or release it. A push-pull output wins over an external drive, so driving is for inputs and open-drain lines. Levels come from the 40 ms state stream, so faster toggling shows as activity, not as individual edges.
   - **Console** defaults to **udp (debug print)**: the device's `log_udp` buffer, read with the same UDP commands TIDE uses (`PC` → `GM0000,02` → `GM0002,10`… → `PR`).
     - Reading dequeues entries, so the reader pauses while a tide-proxy client is fetching debug print through the relay. During that time it rebuilds the lines from the client's traffic, so nothing is lost on either side.
     - UARTs with a socket (for example the `zephyr,console` one) are in the same dropdown and accept typing.

4. **Wire devices together** on the rail. Under each device is a strip of terminals: its UARTs, the pins its DTS names (buttons, LEDs) and any pin you add with **+ pin**. Drag from a terminal to one on another device; click a wire and press Delete (or ×) to remove it. The **Wires** tab lists the same connections and can add them by name. Drag a device by its nameplate to move it along the rail (neighbours make room) or to another rail (**Add rail**); scroll to zoom, drag the background to pan. The arrangement is kept in the browser.
   - **UART:** bytes one end transmits reach every other end's RX. Two ends act as a crossed serial cable, more as an RS485-style bus. Only UARTs enabled in the firmware's DTS have a port. There is no baud rate, flow control or RS485 direction pin, and the instances don't share a clock, so timing-sensitive framing (Modbus RTU's 3.5-character gap) is approximate.
   - **GPIO:** the first pin drives the others while it is an output and releases them otherwise. Buttons and LEDs from the DTS have terminals; add any other pin (`PA0`…`PI15`) with **+ pin**. Changes travel with the 40 ms state stream, so use it for slow signals, not bit-banged buses or pulses.
   - Connections are stored in `sim-data/links.json` and re-applied when instances restart. API: `GET/POST /api/links`, `PATCH/DELETE /api/links/<id>` with `{ kind: 'uart'|'gpio', name?, endpoints: [{ instance, port }] }`.

The same actions are available over HTTP:

```sh
curl localhost:3100/api/instances
curl -X POST localhost:3100/api/instances/<id>/input -H 'Content-Type: application/json' \
     -d '{"button":"mdbutton","pressed":true}'
curl -X POST localhost:3100/api/instances/<id>/reset
curl localhost:3100/api/instances/<id>/screen.png -o screen.png
curl localhost:3100/api/instances/<id>/io   # levels, output masks, [MODER, OTYPER, PUPDR, AFRL, AFRH, ext-driven, ext-level] per port
```

## Monitor

An instance boots through the real Tibbo Monitor/Loader when its flash has one at 0x08000000: its own, written by a `.bin` upload (above), or the default for its generation, set under **Default monitor** in the web UI (or `PUT /api/monitors/g2` with `{ "name", "bin": base64 }`). Use the plain image (for example `TPP2WG2_RELEASE_MON.bin`), not the encrypted `*_ENC.bin` update file: that one can't run and is rejected.

With a monitor, an instance boots through it as a board does:

- Internal flash is a per-instance file, `flash.bin`: the monitor at 0x08000000, then the app from the firmware ELF in the layout the monitor installs (size header and checksum at app base − 0x200), plus any `.bin` writes. The file is written back on every reset and on stop.
- Uploads through TIDE/tide-proxy work: `QF` makes the app set the boot signature and reboot, the monitor comes up as `TiOS-32 Loader`, takes the `D` blocks, flashes them and boots the new app. The upload is the same TiOS-format `.bin` (from `convert_to_tios.js`) that a board takes.
- The monitor never sleeps: its Loader polls the PHY over MDIO in a loop that costs far more host time than it advances the simulated clock, so at the board's clock it runs 20-35x slower than real time. While the CPU executes the monitor it runs at 6 MIPS (`SIM_MONITOR_MIPS`), which keeps the Loader at about real time; the app runs at the board's speed (180 MIPS on G3, 120 on G2). The speed follows the program counter, checked every 10 ms of simulated time.
- An uploaded app stays across restarts. **Reflash** (`POST /api/instances/<id>/reflash`) reinstalls the app from the instance's firmware ELF; uploading a new ELF to the instance does the same. The instance keeps using its DTS for buttons, LEDs and UARTs.
- An instance without firmware starts with an empty app area. On its own the monitor would only blink "Update system" then, so with no valid app in flash (or one linked for the other generation, which the monitor would start and crash into itself) the simulator powers up with the boot signature `QF` leaves (`'U' AA 1E '-'` at 0x2001FFE8 on G2, 0x2002FFE8 on G3) and the monitor's network Loader waits for an upload from TIDE. A reset clears the signature, so after a reset without an app, stop and start the instance.

Without a monitor in flash, the instance boots its ELF through the boot stub, on top of the flash contents (so `.bin` data is there too). With no ELF either, it boots an app a `.bin` put at the app base (a vector table at 0x08008200 / 0x08040200) through the stub.

## tide-proxy

Start tide-proxy with the relay address:

```sh
TIDE_PROXY_SIM_RELAY=127.0.0.1:65530 node lib/server.js
```

Or pass `simRelay` in `TIDEProxyOptions`.

This adds a `renode-sim` interface. Discovery, `X`, state, buzz, reboot and other commands go to the relay, which broadcasts them on the simulated LAN. Device replies come back the same way. Simulated devices then appear next to real ones, with their own MACs. Select `renode-sim` as the interface to talk only to the simulator.

`TIDE_PROXY_SIM_URL` (default `http://localhost:3100`) is the link shown on the tide-proxy page.

## Web UI development

The UI is React + TypeScript in [manager/web](manager/web) and is built into `manager/public`, which the manager serves (the Docker build does this).

```sh
cd sim/manager
npm install
npm run build     # server (tsc) and UI (vite build)
npm run dev:web   # UI on :5173 with hot reload; /api and /ws go to a running manager (SIM_MANAGER_URL, default http://localhost:3100)
```

## Limits

- **Without a monitor, firmware is loaded by the simulator,** by uploading an ELF to an instance. Uploading through TIDE/tide-proxy (`QF`/`D`/`N`) needs the real monitor ([Monitor](#monitor)).
- **Not modelled:** touch, the beeper (DAC/PWM), Wi-Fi (WA2000), and Tibbits other than plain GPIO.
- **Speed:** time runs at real time while firmware is mostly idle. A full-screen LCD redraw takes noticeably longer than on hardware, because every byte is bit-banged through GPIO.

## Layout

```
sim/
  docker/      Dockerfile (Renode 1.17 + sim-manager), entrypoint (bridge, DHCP), compose file
  renode/      tibbo_base.repl, tibbo_g2.repl, tibbo_g3.repl, peripherals/TibboSim.cs
  manager/     Node/TypeScript sim-manager: instances, UDP relay, REST + WebSocket; web/ is the UI (React + Vite), built into public/
```

Renode 1.17 or newer is required. Earlier Synopsys Ethernet MAC models keep the ETH interrupt asserted while DMA interrupts are disabled, which hangs the G3 (STM32F4 HAL v2) Ethernet driver.
