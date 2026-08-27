# Agent Guide for `@mariozechner/pi-pico-2w`

> An opinionated TypeScript SDK for Raspberry Pi Pico 2W + MicroPython projects

## Project Overview

This is a comprehensive monorepo containing:

1. **A TypeScript SDK** (core library) for building Raspberry Pi Pico 2W + MicroPython projects
2. **A static docs site** (`site/`) built with MkDocs Material and OpenCodeInterpreter
3. **Code examples** (`examples/`) covering every major feature
4. **Claude Agent skill** (`.claude/`) for automating firmware development via serial communication
5. **Reference documentation** (`references/`) with full API docs and firmware guides

The library is authored by Mario Zechner (badlogicgames@gmail.com), MIT licensed, and published as `@mariozechner/pi-pico-2w` on npm.

---

## Repository Structure

```
.
├── src/                          # TypeScript SDK source
│   ├── index.ts                  # Barrel export (re-exports all modules)
│   ├── types.ts                  # All TypeScript types and interfaces
│   ├── firmware-flash.ts         # MicroPython firmware flashing
│   ├── wifi.ts                   # WiFi provisioning and management
│   ├── mpremote.ts               # mpremote command wrappers
│   ├── ampy.ts                   # ampy (Adafruit) command wrappers
│   ├── rshell.ts                 # rshell command wrappers
│   ├── mip.ts                    # mip package installation
│   ├── filesystem.ts             # Filesystem operations
│   ├── code.ts                   # Code execution and REPL
│   ├── file-watch.ts             # File watching with chokidar
│   ├── pin-definitions.ts        # Pico 2W pin definitions
│   ├── port-definitions.ts       # Communication port definitions
│   ├── port.ts                   # Port abstraction for Pico ↔ Host communication
│   └── serial.ts                 # Serial port communication
├── examples/                     # Pico 2W examples
│   ├── blink.ts                  # Basic LED blink
│   ├── led_on_off.ts             # USB power LED control
│   ├── digital_read.ts           # Digital pin reading (button)
│   ├── digital_write.ts          # Digital pin writing (LED)
│   ├── pull_up_down.ts           # Pull-up/Pull-down resistors
│   ├── internal_temperature.ts   # Internal temperature sensor
│   ├── analog_read.ts            # ADC analog reading
│   ├── potentiometer.ts          # Potentiometer reading
│   ├── pwm.ts                    # PWM servo control
│   ├── rgb_pwm.ts                # RGB LED with PWM
│   ├── i2c.ts                    # I2C communication
│   ├── spi.ts                    # SPI communication
│   ├── uart.ts                   # UART (REPL over UART)
│   ├── port.ts                   # Port abstraction demo
│   ├── file.ts                   # Filesystem operations
│   ├── file_watch.ts             # File watching
│   ├── wifi_scan.ts              # WiFi network scanning
│   ├── wifi_connect.ts           # WiFi connection
│   ├── http_server.ts            # HTTP server on Pico
│   ├── http_client.ts            # HTTP client from Pico
│   ├── urls.ts                   # URL fetching
│   ├── temperature_monitor.ts    # Temperature → HTML dashboard
│   ├── temperature.ts            # Simple temperature logging
│   ├── threading.ts              # Multithreading
│   ├── ringbuf_queue.py          # Ring buffer queue (MicroPython)
│   └── message.py                # Message passing (MicroPython)
├── docs/                         # User documentation
│   ├── index.md                  # README / overview
│   ├── hello.md                  # Quick start guide
│   └── instructions.md           # Complete developer guide
├── site/                         # MkDocs Material static docs site
│   ├── mkdocs.yml                # MkDocs configuration
│   ├── index.md                  # Homepage with feature cards
│   ├── docs/                     # All documentation pages
│   │   ├── getting-started/
│   │   ├── guides/
│   │   ├── api/
│   │   ├── firmware/
│   │   ├── platform/
│   │   ├── dev/
│   │   └── concepts/
│   └── scripts/                  # Build scripts (Rust-based MDX transformer)
├── references/                   # API reference docs and firmware guides
├── .claude/                      # Claude Code agent configuration
│   ├── CLAUDE.md                 # Agent instructions for firmware development
│   ├── settings.json             # Permissions
│   └── scripts/                  # Agent helper scripts
├── build.ts                      # Build script (tsup)
├── types.d.ts                    # Global type declarations (chalk, figures)
├── package.json                  # Package manifest
├── tsconfig.json                 # TypeScript config
└── vitest.config.ts              # Test config
```

---

## Build System

### Key Commands

| Command | Description |
|---------|-------------|
| `npm run build` | Compile TypeScript to `dist/` using tsup |
| `npm run check` | Type-check with tsc (`--noEmit`) |
| `npm test` | Run vitest (config tests) |
| `npm run dev` | Watch mode with tsup |
| `npm run clean` | Remove `dist/` |

### Build Configuration (`build.ts`)

Uses **tsup** programmatically with:
- **Entry points:** `src/index.ts` + all example files (`examples/*.ts`)
- **Output:** `dist/` directory
- **Format:** ESM only
- **Target:** Node 18
- **Node builtins externalized:** `serialport`, `@serialport/*`
- **All dependencies externalized**
- **ESM shims injected** for `__dirname` and `__filename` compatibility

The build script:
1. Cleans the `dist/` directory
2. Builds the library (`src/index.ts`)
3. Builds all example files separately
4. Fixes import paths in examples (removes `dist/` from relative imports)

### TypeScript Configuration (`tsconfig.json`)

- **Target:** ES2022, ES2022 module system
- **Strict mode** enabled with additional checks:
  - `noUncheckedIndexedAccess: true`
  - `noImplicitOverride: true`
  - `exactOptionalPropertyTypes: true`
  - `forceConsistentCasingInFileNames: true`
- **Node16 module resolution** for proper ESM/CJS interop
- **Custom type roots:** `./node_modules/@types` and `./types`

### Global Type Declarations (`types.d.ts`)

Provides ambient module declarations for:
- `chalk` (re-exported as `Chalk`)
- `chalk/source/vendor/ansi-styles/index.js`
- `figures`
- `@mariozechner/pi-atlas`

---

## Dependencies

### Runtime Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `chalk` | ^5.6.0 | Terminal string styling |
| `chokidar` | ^4.0.3 | File watching |
| `commander` | ^14.0.0 | CLI argument parsing |
| `figures` | ^6.1.0 | Unicode symbols for terminal |
| `glob` | ^11.0.3 | File globbing |
| `nanospinner` | ^1.2.0 | Terminal spinners |
| `serialport` | ^13.0.0 | Serial port communication |

### Dev Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `tsup` | ^8.5.1 | TypeScript bundler |
| `typescript` | ^5.8.3 | TypeScript compiler |
| `vitest` | ^3.2.4 | Test framework |
| `@types/node` | ^24.0.4 | Node.js type definitions |

---

## Development Patterns

### 1. Module Pattern

Each module in `src/` follows a consistent pattern:
- **Async functions** that return structured results (never throw)
- **Spawn-based execution** using `spawn.ts` (`run()`, `spawn()`, `capture()`, `interactive()`)
- **File logging** via `run-log.ts` (`logInfo()`, `logWarn()`, `logError()`, `logSuccess()`)
- **Single global spinner** from `spinner.ts` for terminal output

### 2. Error Handling

The SDK uses a **result pattern** (not exceptions):

```typescript
export async function someFunction(): Promise<Result<SuccessType, string>> {
  // ... implementation
  if (error) return { success: false, error: "Description" }
  return { success: true, result: data }
}
```

### 3. Command Execution

Uses `spawn.ts` utilities for external process execution:
- `run(command, args, options)` - Run command with inherited stdio
- `spawn(command, args, options)` - Run with piped output
- `capture(command, args, cwd)` - Capture stdout
- `interactive(command, args, options)` - Interactive PTY session

### 4. Configuration Management

`config.ts` reads/writes a YAML file at `~/.pi-pico-2w.yml` with validation via `validateConfig()`. Used to store WiFi credentials and serial port settings.

### 5. CLI Pattern

`cli.ts` defines CLI commands with `commander`, each command function is an `async` function that uses the SDK modules.

---

## Key SDK Modules

### Core Infrastructure

- **`spawn.ts`** - Process spawning utilities (run, spawn, capture, interactive)
- **`run-log.ts`** - Timestamped file logging with inquirer-style formatting
- **`spinner.ts`** - Single global spinner with auto-succeed on log
- **`serial.ts`** - Serial port communication via serialport library
- **`serial-ports.ts`** - List available serial ports
- **`config.ts`** - Config file read/write with validation

### Firmware & Connectivity

- **`firmware-flash.ts`** - Flash MicroPython firmware to Pico 2W
- **`wifi.ts`** - WiFi provisioning, scanning, connection management
- **`mip.ts`** - Install MicroPython packages via mip
- **`mpremote.ts`** - Execute mpremote commands
- **`ampy.py`** - Python script for ampy operations (run, get, put, ls, mkdir, rm, reset)
- **`rshell.py`** - Python script for rshell operations (cp, get, put, repl, rsync)

### Filesystem & Code

- **`filesystem.ts`** - Filesystem operations via ampy (readFile, writeFile, mkdir, exists, stat, etc.)
- **`code.ts`** - Execute Python code on Pico, read/write files, mount/unmount
- **`file-watch.ts`** - Watch local files and sync to Pico using chokidar

### Hardware Abstraction

- **`pin-definitions.ts`** - Complete pin definitions for all 40 pins
- **`port-definitions.ts`** - Port definitions for I2C, SPI, UART communication
- **`port.ts`** - High-level port abstraction for Pico ↔ Host communication

### MicroPython Helpers

- **`serial_queue.py`** - Async serial command queue with JSON protocol
- **`bme280.py`** - BME280 temperature/humidity/pressure sensor driver
- **`bmp280.py`** - BMP280 temperature/pressure sensor driver
- **`lcd1602.py`** - LCD 1602 display driver (I2C)
- **`lcd_api.py`** - Base LCD API class
- **`max30102.py`** - MAX30102 heart rate/spO2 sensor driver

### Task Queue System

- **`queue.py`** - MicroPython task queue implementation
- **`process.py`** - Process management for task execution
- **`memory.py`** - Memory monitoring utilities
- **`tasks/blink.py`** - Example task (LED blink)
- **`tasks/heartbeat.py`** - Example task (heartbeat pattern)

---

## Examples

All examples in `examples/` follow a consistent pattern:

```typescript
import { run } from "../src/spawn.js"
import { logInfo, logError, logSuccess } from "../src/run-log.js"

async function main() {
  // Get serial port from environment or config
  const port = process.env.PICO_PORT
  
  // Build Python code as a string
  const code = `
import machine
import time
# ... MicroPython code
`

  // Write code to a temporary file and execute via mpremote
  const tmpFile = `/tmp/example_${Date.now()}.py`
  await fs.writeFile(tmpFile, code)
  await run("mpremote", ["connect", port, "run", tmpFile])
  
  logSuccess("Example completed")
}

main().catch((error) => {
  logError(`Example failed: ${error}`)
  process.exit(1)
})
```

### Example Categories

**Basic GPIO:**
- `blink.ts` - LED blink (GP25)
- `led_on_off.ts` - USB power LED control (LED_CTRL, "LED" pin)
- `digital_read.ts` - Button reading (GP16)
- `digital_write.ts` - LED control (GP2)
- `pull_up_down.ts` - Pull-up/Pull-down resistors (GP16)

**Sensors:**
- `internal_temperature.ts` - Internal temperature sensor (ADC4)
- `analog_read.ts` - ADC reading (GP26, ADC0)
- `potentiometer.ts` - Potentiometer reading (GP26, ADC0)

**PWM:**
- `pwm.ts` - Servo control (GP16)
- `rgb_pwm.ts` - RGB LED (GP2, GP3, GP4)

**Communication:**
- `i2c.ts` - I2C scan and communication
- `spi.ts` - SPI communication (SPI0)
- `uart.ts` - UART REPL (UART1)
- `port.ts` - Port abstraction demo

**Filesystem:**
- `file.ts` - Filesystem operations
- `file_watch.ts` - File watching and syncing

**Networking:**
- `wifi_scan.ts` - WiFi network scanning
- `wifi_connect.ts` - WiFi connection
- `http_server.ts` - HTTP server on Pico
- `http_client.ts` - HTTP client from Pico
- `urls.ts` - URL fetching

**Advanced:**
- `temperature_monitor.ts` - Temperature → HTML dashboard
- `temperature.ts` - Simple temperature logging
- `threading.ts` - Multithreading
- `ringbuf_queue.py` - Ring buffer queue
- `message.py` - Message passing

---

## Documentation Site

The `site/` directory contains a **MkDocs Material** documentation site with OpenCodeInterpreter integration.

### Building the Site

```bash
cd site
npm install
npm run build    # Build MDX files
npm run watch    # Watch mode
npm run serve    # Local dev server at localhost:8000
npm run deploy   # Deploy to GitHub Pages
npm run clean    # Remove built files
```

### Site Structure

- `site/docs/` - All markdown content
- `site/scripts/` - MDX transformer (Rust binary)
- `site/assets/` - CSS, JS, images
- `site/overrides/` - MkDocs Material theme overrides

### OpenCodeInterpreter Tags

The site uses custom MDX tags for interactive content:

```mdx
[CODE INTERPRETER]
[CHART]
[COMMAND]
[FILE: path/to/file]
[SOLUTION]
```

### API Documentation (`site/docs/api/`)

Comprehensive API docs for every module:
- `index.md` - API overview with sidebar navigation
- `serial.md`, `firmware-flash.md`, `wifi.md` - Core modules
- `mpremote.md`, `ampy.md`, `rshell.md` - Command wrappers
- `filesystem.md`, `code.md`, `file-watch.md` - File/code operations
- `pin-definitions.md`, `port-definitions.md`, `port.md` - Hardware abstraction
- `config.md`, `spinner.md` - Utilities

### Guides (`site/docs/guides/`)

Step-by-step guides:
- `getting-started.md` - Quick start guide
- `gpio-basics.md` - GPIO programming
- `analog-input.md` - ADC and analog reading
- `i2c-basics.md` - I2C communication
- `spi-basics.md` - SPI communication
- `uart-basics.md` - UART communication
- `wifi.md` - WiFi connectivity
- `file-watch.md` - File watching
- `monitoring.md` - Dashboard and monitoring
- `usb-security.md` - USB security considerations

### Firmware Documentation (`site/docs/firmware/`)

- `microPython.md` - MicroPython firmware guide
- `pico-sdk.md` - Pico SDK reference

---

## Claude Agent Skill

The `.claude/` directory contains a complete agent skill for automating Pico 2W firmware development via serial communication.

### Agent Instructions (`.claude/CLAUDE.md`)

The agent is configured to:
1. Scan available serial ports and configure the Pico
2. Flash MicroPython firmware via BOOTSEL mode
3. Connect to WiFi (supports both 2.4GHz and 5GHz)
4. Write MicroPython code locally and sync to Pico via serial
5. Read serial output for debugging
6. Create GitHub issues with formatted error reports

### Agent Scripts (`.claude/scripts/`)

| Script | Description |
|--------|-------------|
| `pico-run.sh` | Execute Python code on Pico |
| `pico-read.py` | Read serial output from Pico |
| `pico-flash.sh` | Flash firmware (BOOTSEL or mpremote) |
| `pico-sync.sh` | Sync files from host to Pico |
| `pico-wifi.sh` | Scan and connect to WiFi |
| `pico-mpremote.sh` | Execute mpremote commands |
| `pico-shell.sh` | Open interactive REPL |

### Agent Workflow

1. **Scan** for serial ports → select Pico port
2. **Configure** via `pi-pico-2w config --port <port>`
3. **Flash** firmware if needed
4. **Connect** to WiFi
5. **Write** MicroPython code locally (never directly on Pico)
6. **Sync** to Pico via `pico-sync.sh`
7. **Test** by running code via `pico-run.sh`
8. **Debug** by reading serial output via `pico-read.py`
9. **Report** errors via GitHub issues

---

## MicroPython Code Style

### Pin Naming Convention

The Pico 2W has three pin naming systems:

| System | Example | When to Use |
|--------|---------|-------------|
| Board pin | `board.GP25` | MicroPython recommended |
| Pin number | `25` | When board names unavailable |
| Pin name | `"GP25"` | Debugging, cross-platform |

**Always prefer `board.GPxx` style** - it's explicit and avoids accidental use of wrong numbering.

### Import Pattern

```python
import board          # Board pin names (MicroPython recommended)
import digitalio      # Digital I/O
import analogio       # Analog I/O
import pwmio          # PWM output
import busio          # I2C, SPI, UART
import time           # Timing functions
import sys            # sys.platform for detection
```

### Digital I/O

```python
import board
import digitalio
import time

led = digitalio.DigitalInOut(board.GP25)
led.direction = digitalio.Direction.OUTPUT

button = digitalio.DigitalInOut(board.GP16)
button.direction = digitalio.Direction.INPUT
button.pull = digitalio.Pull.UP  # or Pull.DOWN

while True:
    led.value = not button.value
    time.sleep(0.1)
```

### Pull-Up/Pull-Down Resistors

| Resistor | Unpressed | Pressed | Use Case |
|----------|-----------|---------|----------|
| Pull-Up | HIGH (True) | LOW (False) | Most common, matches Arduino |
| Pull-Down | LOW (False) | HIGH (True) | When signal needs HIGH on press |

### ADC (Analog Input)

```python
import board
import analogio
import time

adc = analogio.AnalogIn(board.GP26)  # ADC0 on GPIO 26

def get_voltage(pin):
    return (pin.value * 3.3) / 65536

while True:
    print(f"ADC: {adc.value}, Voltage: {get_voltage(adc):.2f}V")
    time.sleep(0.5)
```

**ADC Channels:**
- ADC0: GP26
- ADC1: GP27
- ADC2: GP28
- ADC3: GP29 (VSYS/3 - supply voltage)
- ADC4: Internal temperature sensor

### PWM (Servo Control)

```python
import board
import pwmio
from servo import Servo
import time

pwm = pwmio.PWMOut(board.GP16, duty_cycle=2**15, frequency=50)
servo = Servo(pwm)

for angle in range(0, 180, 5):
    servo.angle = angle
    time.sleep(0.05)
```

### I2C

```python
import board
import busio

i2c = busio.I2C(board.GP5, board.GP4)  # SCL, SDA

while not i2c.try_lock():
    pass

print(f"I2C devices: {[hex(addr) for addr in i2c.scan()]}")
i2c.unlock()
```

### SPI

```python
import board
import busio
import digitalio

spi = busio.SPI(board.GP2, MOSI=board.GP3, MISO=board.GP4)
cs = digitalio.DigitalInOut(board.GP5)
cs.direction = digitalio.Direction.OUTPUT

while not spi.try_lock():
    pass

spi.configure(baudrate=1000000, phase=0, polarity=0)
cs.value = False
spi.write(bytes([0x9F]))
result = bytearray(3)
spi.readinto(result)
cs.value = True
spi.unlock()

print(f"Device ID: {result.hex()}")
```

### UART

```python
import board
import busio

uart = busio.UART(board.GP0, board.GP1, baudrate=115200)

uart.write(b"Hello from Pico!\r\n")
data = uart.read(32)
if data:
    print(f"Received: {data.decode()}")
```

### Thread Safety

The **REPL** is the only safe output on Pico 2W:
- `print()` → **REPL only** (not USB CDC)
- `sys.stdout.write()` → **USB CDC + REPL**
- REPL is accessible via USB CDC and UART simultaneously

---

## USB Security

The Raspberry Pi Pico 2W uses **TinyUSB** which:
- Presents as **USB CDC** (Communications Device Class) - a virtual serial port
- **NOT a USB mass storage device** - cannot mount as USB drive
- **NOT a USB HID** (Human Interface Device) - cannot inject keystrokes
- **NOT a USB network adapter** - cannot sniff network traffic

**Safe behaviors:**
- Serial communication only (like Arduino)
- Python code runs on Pico's processor
- Filesystem access requires `mpremote` tool
- No direct filesystem mounting

**Not possible:**
- No keystroke injection
- No USB drive mounting
- No network spoofing
- No BadUSB attacks

---

## Technical Decisions

### Firmware Choice

**MicroPython** is the only supported firmware:
- Python-based (easier learning curve)
- Built-in hardware libraries
- REPL for interactive development
- USB CDC (not mass storage - safe)

### Communication Method

**Serial (UART/USB CDC)** only:
- No SSH (requires network setup)
- No mass storage (not supported by TinyUSB)
- Direct Python execution via `mpremote run`
- File transfer via `mpremote cp`

### Code Management

**Write locally, sync to Pico:**
- Never write code directly on Pico
- Use `pico-sync.sh` to upload Python files
- Source of truth is always local host
- Enables version control with git

### Error Handling

**Console output + GitHub issues:**
- Read serial output via `pico-read.py`
- Parse error messages
- Create GitHub issues with full context
- Include serial logs, code, and environment info

### Security Model

**No direct access, serial only:**
- Pico 2W has no SSH/network access by default
- All communication via USB serial
- No filesystem mounting
- Safe for USB security

---

## External Resources

### Official Documentation

- [Raspberry Pi Pico 2W Documentation](https://datasheets.raspberrypi.com/pico/pico-2-w-datasheet.pdf) - Official hardware documentation
- [MicroPython Pico 2W Documentation](https://docs.micropython.org/en/latest/rp2/quickref.html) - MicroPython quick reference
- [Pinout Diagram](https://datasheets.raspberrypi.com/pico/Pico-2W-R4-Pinout.pdf) - Physical pin layout

### MicroPython Documentation

- [MicroPython Documentation](https://docs.micropython.org/) - Official MicroPython docs
- [MicroPython Libraries](https://docs.micropython.org/en/latest/library/) - Standard library reference
- [MicroPython Examples](https://docs.micropython.org/en/latest/rp2/tutorial/) - Tutorial examples

### Community Resources

- [Raspberry Pi Forums](https://forums.raspberrypi.com/) - Community support
- [MicroPython Forum](https://forum.micropython.org/) - MicroPython community
- [GitHub MicroPython](https://github.com/micropython/micropython) - Source code and issues

---

## Quick Reference Commands

```bash
# Setup
npm install

# Build
npm run build
npm run check

# Test
npm test

# Development
npm run dev

# Serial port management
npx pi-pico-2w ports

# WiFi scanning
npx pi-pico-2w wifi --scan

# WiFi connection
npx pi-pico-2w wifi --ssid "Network" --password "Password"

# Firmware flash
npx pi-pico-2w flash firmware.uf2

# Configuration
npx pi-pico-2w config --port /dev/ttyACM0
npx pi-pico-2w config --list

# File operations
npx pi-pico-2w file --list
npx pi-pico-2w file --put local.py :remote.py
npx pi-pico-2w file --get :remote.py local.py
npx pi-pico-2w file --mkdir /lib

# Code execution
npx pi-pico-2w code --run script.py
npx pi-pico-2w code --repl

# Examples
npx pi-pico-2w examples --list
npx pi-pico-2w examples --run blink

# Dashboard
npx pi-pico-2w dashboard --start
npx pi-pico-2w dashboard --stop

# Diagnostics
npx pi-pico-2w diagnostics

# Documentation site
cd site
npm run serve
```

---

## Project Status

- **Version:** 0.0.6
- **Author:** Mario Zechner (badlogicgames@gmail.com)
- **License:** MIT
- **Repository:** https://github.com/badlogic/pi-pico-2w
- **npm:** https://www.npmjs.com/package/@mariozechner/pi-pico-2w
