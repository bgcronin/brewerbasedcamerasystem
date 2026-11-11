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

1. **Put the Lumen folder somewhere plain**, such as `C:\Lumen` on Windows. Unpack the whole download there first; nothing works from inside the ZIP. Avoid Desktop and Documents if they are kept in OneDrive: syncing thousands of small files slows every start, can lock files while Lumen is being built, and would copy Canon's SDK to the cloud.
2. **Install Node.js** (LTS, version 20 or newer) from [nodejs.org](https://nodejs.org). This is the only installation needed. The helper itself is just the files in this folder.
3. **Put Canon's SDK in [`sdk/`](sdk/README.md).** Unzip the EDSDK download there, keeping Canon's folder names.
4. **Set up the camera** (EOS 60D):
   - Mode dial on **M**. Lumen can then set shutter speed and aperture; in Av or Tv only some settings can be changed.
   - In the camera's shooting menu, set **Live View shooting → Enable**.
   - Image quality **JPEG L (fine)**, or RAW+JPEG. The RAW stays on the card.
   - Keep a memory card in, with free space and not write-protected. Every photo is also saved to it as a backup, and the camera may refuse to fire without a card it can write to. (To work with no card at all, start Camera Link with `--save-to host`.)
   - For long clinics, use Canon's AC adapter kit (ACK-E6 for the 60D), because live view uses a lot of battery.
5. **Stop EOS Utility opening by itself.** Only one program can control the camera at a time. In EOS Utility's preferences, turn off launching automatically when a camera connects (or quit it before you start).

## Every day

Connect the camera by USB, switch it on, then double-click:

- **Mac:** `Start Camera Link.command`. The first time, right-click it and choose **Open**, because macOS warns about apps that don't come from the App Store.
- **Windows:** `Start Camera Link.bat`

A small window opens (keep it open while you work) and Lumen opens in your browser. In Lumen, open **Camera source → Canon EOS via Camera Link**. Lumen remembers this choice.

The first start installs a few files and builds Lumen, which takes a few minutes and needs the internet. After that a start takes a second or two. When Lumen's files have changed (an update), the next start rebuilds it; if that fails, the window says why and the previous build is used, so Lumen is never left unusable.

The window also says where photos go that could not be handed to Lumen (the **Unfiled** folder, see below).

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

Photos taken with the camera's own shutter button while Lumen is closed are never lost. The helper saves them to `Pictures/Lumen Camera Link/Unfiled` (the exact folder is shown when it starts; change it with `--unfiled-dir`) and tells Lumen the next time a Lumen window is looked at. The same happens to a photo that Lumen does not confirm receiving within ten seconds, for instance because its window froze. They're also on the memory card.

Keep Lumen open in **one** window. With two, a photo taken with the camera's own button goes to the window you used last, and the Camera Link window warns that two are open.

## The slit lamp's own button does not take a photo

The button on the joystick (or any remote release wired to the camera) works the camera directly. Camera Link then fetches the photo from the camera and passes it to Lumen. If you press it and nothing appears in Lumen, two things show where it went wrong: **did the camera click**, and **what did the Camera Link window print?**

| The camera | The Camera Link window shows | What it means and what to do |
| --- | --- | --- |
| clicks | `photo IMG_… from the camera’s own shutter button`<br>`Lumen is not open — saved IMG_… to …` | The photo arrived, but no Lumen window was connected. In Lumen choose **Camera source → Canon EOS via Camera Link**, in the window at `http://localhost:47800` that Camera Link opens. The photo is in the Unfiled folder: add it to the patient with **Add photos from files**. |
| clicks | `sent IMG_… to Lumen`<br>`IMG_… received by Lumen` | Lumen has it. If no patient was selected, it is waiting in the bar **“1 photo waiting for a patient”**: choose the patient and press **File to…**. If the line ends `(window 2 of 2, …)`, it went to another Lumen window: close the spare one. |
| clicks | `sent IMG_… to Lumen`<br>`Lumen did not confirm IMG_… — saved IMG_… to …` | The Lumen window did not answer (frozen, or put to sleep by the browser). Reload Lumen. The photo is in the Unfiled folder. |
| clicks | nothing new | Camera Link heard nothing from the camera. Scroll up: is there a line `connected to Canon EOS 60D`? If not, see “Connect the Canon” above (EOS Utility is usually the reason). If there is a line `THE CAMERA HAS SENT NO EVENTS`, quit EOS Utility, unplug the camera, plug it in again and restart Camera Link. If the camera is set to **RAW only**, Lumen shows a note instead of a photo: set image quality to JPEG or RAW+JPEG. |
| clicks | `the camera saved IMG_… to its memory card without offering it to the computer; fetching it from the card` | The camera is keeping photos to itself. Camera Link fetches them from the card instead (they appear a few seconds later) and asks the camera again. Nothing to do; if it happens every time, switch the camera off and on. |
| does not click | nothing | The camera itself refused. Check the memory card first: Camera Link asks the camera to keep a copy of every photo on the card, so it needs a card that is present, not full and not write-protected. Look for `shots available: 0` in the window. Put in a card with space, or start Camera Link with `--save-to host` to use no card. |
| does not click, but Lumen's own shutter (Space) works | nothing | Probably live view: see the two quick tests below. |
| stops clicking after a photo taken from Lumen | `warning: … (release shutter)` | The camera still believes Lumen is holding its shutter button down. Camera Link keeps trying and prints `shutter button released` when it has succeeded. If it does not, switch the camera off and on. |

**Two quick tests for live view.** While Lumen shows the Canon's live picture, the camera works in live view mode, which it did not when you used EOS Utility. Some set-ups release differently in that mode.

1. Open Lumen's **Review** screen (press V), so the live picture is not showing, and press the slit lamp's button. Lumen switches the camera's live view off whenever the live picture is not on screen.
2. Or start Camera Link with live view switched off for the whole session: `"Start Camera Link.bat" --no-live-view` (Mac: `./Start\ Camera\ Link.command --no-live-view`). Lumen then shows no live picture, but photos arrive as usual.

If the button works in these tests and not otherwise, the camera will not release in live view with this slit lamp. Check that the lens or adapter is set to **MF** (in live view the camera tries to focus before releasing), and hold the button a little longer. If the slit lamp has a flash, also set the camera's **Silent shooting** (Live View menu) to **Disable**: in the other settings the 60D does not fire a flash that is not Canon's own. Otherwise keep using `--no-live-view`.

Clicking inside the Camera Link window used to pause it on Windows 10 until a key was pressed; Camera Link now switches that behaviour off for its own window. If its title ever starts with “Select”, press Esc.

## Safety and privacy

- The helper only accepts connections from this computer (`localhost`). Other websites, and other computers on the network, can't reach the camera.
- Photos go straight from the camera to Lumen on the same computer. Nothing is uploaded.

## Options

```
node src/main.js [--simulate] [--port 47800] [--open] [--no-serve]
                 [--save-to both|host] [--no-live-view] [--unfiled-dir <folder>]
                 [--sdk <path>] [--sdk-generation 3|13]
                 [--allow-origin https://lumen.example.org]
```

`--save-to host` stops copies being written to the memory card (a RAW file is then kept in the Unfiled folder, as it has no other copy). `--no-live-view` never switches the camera's live view on. `--unfiled-dir` chooses where photos go that could not be handed to Lumen. `--allow-origin` lets a Lumen hosted at another address use the helper. The start files pass these on: `"Start Camera Link.bat" --no-live-view`.

`http://localhost:47800/status` shows what the helper sees: the camera, how many Lumen windows are connected and which one would get the next photo, and counts of camera events and photos.

## For developers

- `src/edsdk/`: koffi bindings to EDSDK. These handle the 3.x and 13.x interfaces, which differ in their stream and download size types; the helper detects which one by reading `EDSDK.h`.
- `src/simulator.js`: the pretend camera. `src/server.js`: the WebSocket protocol Lumen speaks (described at the top of the file), which window a photo goes to, and the Unfiled folder.
- `src/build-lumen.js`: what the start files use to build Lumen: only when its source changed, into a spare folder, swapped in only on success.
- `npm test` builds `test/fake-edsdk.c`, a stand-in for Canon's library that behaves like a 60D, and runs the real backend against both interfaces, once for each way the camera can behave (RAW+JPEG, the camera's own button, card-only saving, a lost connection and so on; see `test/run-fake-sdk.sh`). It then tests the server with the pretend camera, and the Lumen build step. It needs a C compiler on Linux or macOS.
- The pretend camera's own shutter button can be pressed over the link, for trying the "camera button" path: send `{ "type": "sim-button" }` to `ws://127.0.0.1:47800/camera`. The real camera ignores it.
