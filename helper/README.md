# Lumen Camera Link

A small companion program that connects a **Canon EOS** (built and tested for the **EOS 60D**) to Lumen using Canon's own SDK (EDSDK). It runs on **Windows and macOS**.

With it, Lumen can:

- show the Canon's **live view** on its main screen
- **fire the shutter** from Lumen: Space, a foot switch on the computer, or the on-screen shutter
- read and set **ISO, shutter speed, aperture and white balance**
- save those settings as a **preset for each illumination** (diffuse, slit, cobalt blue…), applied automatically when you choose that illumination
- record each photo's exposure settings with the photo

It also serves Lumen itself, so on the clinic computer you start this one program and use Lumen at **http://localhost:47800**.

## One-time setup

1. **Install Node.js** (LTS) from [nodejs.org](https://nodejs.org). This is the only installation needed. The helper itself is just the files in this folder.
2. **Put Canon's SDK in [`sdk/`](sdk/README.md).** Unzip the EDSDK download there, keeping Canon's folder names.
3. **Set up the camera** (EOS 60D):
   - Mode dial on **M**. Lumen can then set shutter speed and aperture; in Av or Tv only some settings can be changed.
   - In the camera's shooting menu, set **Live View shooting → Enable**.
   - Image quality **JPEG L (fine)**, or RAW+JPEG. The RAW stays on the card.
   - Keep a memory card in. Every photo is also saved to it as a backup.
   - For long clinics, use Canon's AC adapter kit (ACK-E6 for the 60D), because live view uses a lot of battery.
4. **Stop EOS Utility opening by itself.** Only one program can control the camera at a time. In EOS Utility's preferences, turn off launching automatically when a camera connects (or quit it before you start).

## Every day

Connect the camera by USB, switch it on, then double-click:

- **Mac:** `Start Camera Link.command`. The first time, right-click it and choose **Open**, because macOS warns about apps that don't come from the App Store.
- **Windows:** `Start Camera Link.bat`

A small window opens (keep it open while you work) and Lumen opens in your browser. In Lumen, open **Camera source → Canon EOS via Camera Link**. Lumen remembers this choice.

The first start installs a few files, which takes a minute. After that, each start refreshes Lumen in a few seconds, so updates are picked up automatically.

### Try it without the camera

```bash
cd helper
npm install
npm run simulate
```

This starts a pretend EOS 60D with live view, working settings and captures, so you can try the whole flow (or show it to a colleague) without the camera.

## Presets

1. Choose an illumination in Lumen, e.g. **Cobalt** (press 6).
2. Set ISO, shutter speed, aperture and white balance in the **Camera** panel, or on the camera itself.
3. Click **Save as Cobalt blue / NaFl preset**.

From then on, choosing Cobalt dials those settings back in. Illuminations with a preset show a small blue dot. Manage presets in **Settings → Canon camera presets**.

## If something goes wrong

| Lumen says | What to do |
| --- | --- |
| Start Lumen Camera Link | The helper isn't running: double-click the start file. |
| Connect the Canon | Check the USB cable, switch the camera on, and quit EOS Utility. |
| Another program is using the camera | Quit EOS Utility, Image Capture or Photos, then unplug and replug the camera. |
| Canon SDK not found | The SDK isn't in `helper/sdk/`. See [sdk/README.md](sdk/README.md). |
| This version of the Canon SDK does not support this camera | Use an older EDSDK 3.x release for the 60D (see [sdk/README.md](sdk/README.md)). |
| Live view could not start | Enable Live View shooting in the camera menu. |
| The dial is on Av | Turn the mode dial to M to set shutter speed and aperture from Lumen. |

Photos taken with the camera's own shutter button while Lumen is closed are never lost. The helper saves them to `Pictures/Lumen Camera Link/Unfiled` and tells Lumen next time it connects. They're also on the memory card.

## Safety and privacy

- The helper only accepts connections from this computer (`localhost`). Other websites, and other computers on the network, can't reach the camera.
- Photos go straight from the camera to Lumen on the same computer. Nothing is uploaded.

## Options

```
node src/main.js [--simulate] [--port 47800] [--open] [--no-serve]
                 [--save-to both|host] [--sdk <path>] [--sdk-generation 3|13]
                 [--allow-origin https://lumen.example.org]
```

`--save-to host` stops copies being written to the memory card. `--allow-origin` lets a Lumen hosted at another address use the helper.

## For developers

- `src/edsdk/`: koffi bindings to EDSDK. These handle the 3.x and 13.x interfaces, which differ in their stream and download size types; the helper detects which one by reading `EDSDK.h`.
- `src/simulator.js`: the pretend camera. `src/server.js`: the WebSocket protocol Lumen speaks (described at the top of the file).
- `npm test` builds `test/fake-edsdk.c`, a stand-in for Canon's library that behaves like a 60D, and runs the real backend against both interfaces. It needs a C compiler on Linux or macOS.
