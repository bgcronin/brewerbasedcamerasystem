# Lumen · Slit Lamp Imaging

Browser-based slit lamp photography for the ophthalmology clinic. Import the day's clinic list, pick a patient, choose the eye, and photograph. Every image is labelled with patient, eye (OD / OS / OU) and illumination technique, then stored as an efficient WebP file in a clean folder per patient and visit.

![Capture view](docs/screenshots/capture.webp)

- **Runs entirely on the clinic PC.** Nothing is uploaded. Patient details and photographs live in the browser's database and, optionally, in an archive folder you choose (a local drive or network share).
- **Works with your cameras.** The Canon EOS connects directly through **Lumen Camera Link**, built on Canon's SDK: live view in Lumen, the shutter fired from Lumen or a foot switch, and ISO, shutter speed, aperture and white balance with a preset for each illumination. The CSO Mizar (or any USB camera) gives live view and capture in the browser.
- **Built for the slit lamp room.** A dark "Night" theme that doesn't spoil dark adaptation, a large shutter, Space or foot-switch capture, R/L eye keys, and safety cues: the eye colour runs through the live view, the shutter ring and every thumbnail.

| Import a clinic list | Review, compare, export |
| --- | --- |
| ![Import](docs/screenshots/import.webp) | ![Review](docs/screenshots/review.webp) |

---

## Quick start

You need [Node.js](https://nodejs.org) 20 or newer, and **Google Chrome or Microsoft Edge** on the clinic PC. Those two browsers support folder access, which the archive and Canon features need.

```bash
npm install
npm run build
npm start
```

Open **http://localhost:4173** in Chrome or Edge. To make it feel like a native app, click the install icon in the address bar (⊕ "Install Lumen"). It then opens in its own window and works offline.

**On the computer with the Canon**, use the helper instead: double-click `helper/Start Camera Link.command` (Mac) or `helper/Start Camera Link.bat` (Windows). It builds Lumen, connects the camera and opens Lumen at **http://localhost:47800**. See [Canon EOS: direct control](#canon-eos-direct-control-recommended).

> Pick one address per computer and stick to it. The browser keeps Lumen's patients and photos per address, so data saved at `localhost:4173` won't appear at `localhost:47800`. The archive folder is the same either way.

For development with live reload: `npm run dev` → http://localhost:5173.

> Cameras and folder access only work on `localhost` or an `https://` address. To host it on the clinic network, serve the `dist/` folder over HTTPS. It is static files only: no server code and no database server.

### First-time setup (about two minutes)

1. **Settings → Archive folder → Choose folder.** Pick a folder on a backed-up drive or network share, e.g. `D:\SlitLamp\Archive`. When Chrome asks, choose **Allow on every visit**.
2. **Camera source** (bottom-left of the live view) → choose the slit lamp camera, or set up the Canon (below).
3. Optional: **Settings → Clinic name**, and bind your foot switch key.

---

## Daily workflow

1. **Import list.** Drop the day's CSV onto the window, or use *Import list*. Lumen recognises the usual column headings and shows a preview before anything is saved.
2. **Pick a patient** (click, or ↑ ↓). The eye resets to OD for each new patient.
3. **Choose the eye** (R / L / B) and, optionally, the illumination (1–8: diffuse, slit, retro, specular, scatter, cobalt blue, red-free, external).
4. **Capture** with Space, the foot switch or the shutter button. You get a soft flash and click, and the thumbnail drops into the filmstrip.
5. **Review** (V) shows every visit right eye beside left. Open any photo to zoom to 1:1, star it, add a note, re-label it, or **compare** it side by side with a previous visit using linked zoom. **Export** packs the patient's photos into a ZIP.

Deleted a photo by mistake? Press **Undo** on the notice that appears. Relabelling a photo (OD → OS, or a different illumination) renames its file in the archive folder too, so the folder always agrees with the label.

---

## Connecting the cameras

### CSO Mizar (slit lamp camera)

The Mizar is a 5-megapixel (2448 × 2048) USB 3.0 camera.

- **If Windows sees it as a camera** (it appears in the Windows *Camera* app), it will appear in Lumen under **Camera source → Live cameras**. Choose it and leave resolution on **Maximum**. You get live view on screen, and each capture is a full 2448 × 2048 frame.
- **If it only works inside CSO Phoenix** (a vendor-specific driver), keep using Phoenix to capture, set Phoenix to save or export images to a folder, and point Lumen's **folder watch** at that folder (same steps as the Canon below).
- A camera can only be used by one program at a time. Close Phoenix's live view before using live mode in Lumen.
- If the image is mirrored or rotated by the beam splitter, use the **rotate / mirror** buttons on the live view. They are remembered for that camera.

### Canon EOS: direct control (recommended)

![Canon direct control](docs/screenshots/canon-direct.webp)

**Lumen Camera Link** (in [`helper/`](helper/README.md)) is a small companion program that drives the Canon through Canon's SDK on Windows or Mac. With the EOS 60D:

- Canon live view on Lumen's stage, with a viewfinder-style readout (M · 1/125 · f/8 · ISO 400).
- The shutter fires from Lumen: Space, a foot switch on the computer, or the on-screen button. Photos taken with the camera's own shutter button are filed too.
- **ISO, shutter speed, aperture and white balance** can be changed from the Camera panel. Save them as a **preset for each illumination**: choose Cobalt, set ISO 1600, *Save as Cobalt preset*, and from then on pressing 6 dials it straight back in.
- Every photo records the settings it was taken with, and the memory card keeps a backup copy.

**Where to put Canon's SDK:** unzip it into [`helper/sdk/`](helper/sdk/README.md), keeping Canon's folder names. That folder is excluded from git, because the SDK is licensed to you and this repository is public. The full setup (camera menu settings, EOS Utility auto-start, Mac first-run) is in [helper/README.md](helper/README.md).

No camera handy? `cd helper && npm install && npm run simulate` starts a pretend EOS 60D for trying the whole flow.

### Canon EOS: folder watch (no helper)

The fallback when Camera Link can't be used. Canon's free **EOS Utility 3** saves each shot to a folder, and Lumen watches that folder.

1. Connect the camera by USB and open **EOS Utility → Remote Shooting**.
2. In EOS Utility **Preferences → Destination Folder**, choose an empty folder, e.g. `C:\SlitLamp\EOS`. Tip: in Preferences, set EOS Utility to start straight in Remote Shooting.
3. Set the camera to **JPEG (L, fine)**. RAW + JPEG also works (Lumen takes the JPEG). Browsers can't display RAW or HEIF.
4. In Lumen: **Camera source → Choose the EOS Utility folder…** and pick the same folder.

Now every shot, whether from the camera's shutter, a remote release or a foot switch wired to the camera, appears in Lumen within a second, filed to the selected patient and eye. Photos that arrive before you've chosen a patient are held. Pick the patient, then file them with one click. Original files stay in the EOS folder unless you turn on *Settings → Tidy the Canon folder*.

### Foot switch

Most USB foot pedals act as a keyboard. Program the pedal to send **Space**, or go to **Settings → Shutter keys → Add key** and press the pedal. Holding the pedal down never fires a burst: one press is one photo.

---

## Patient lists (CSV)

Any CSV, TSV or text export works, including rows copied straight from Excel or your PAS and pasted into the import sheet. Lumen recognises common headings:

| Field | Recognised headings (examples) |
| --- | --- |
| Patient ID | MRN, Hospital No, Patient ID, Chart No, NHS Number, PAS No, URN |
| Name | Surname + Forename / First name, or a single *Name* column (`SMITH, John`, `John Smith`, `Mr John SMITH`) |
| Date of birth | DOB, D.O.B., Date of Birth, Birth Date |
| Appointment | Time / Appt Time / Start, Date / Clinic Date (combined `03/11/2026 09:30` is fine) |
| Other | Sex / Gender, Clinic / Location, Consultant / Clinician, Reason / Appointment Type, Notes |

- Dates are read as **DD/MM/YYYY** or **MM/DD/YYYY** automatically from the data, and you can override this. When a file can't be told apart (every day is 12 or less), Lumen assumes day first and says so in the import sheet. ISO, `12-Mar-1956` and Excel serial dates also work.
- Patients are matched across days by **MRN** (spacing and case are ignored, so `123 456 7890` and `1234567890` are the same number), so each person keeps one photo history. Without an MRN, matching falls back to name + date of birth. Two patients can never share an MRN: adding a patient with a known MRN attaches a visit to the existing record instead.
- Each patient's archive folder name is fixed the first time a photo is written, so correcting a name or adding an MRN later never splits their history.
- A sample list is in [`public/sample-worklist.csv`](public/sample-worklist.csv). Every patient in it is fictitious.

### Adding other import systems

Importers live in [`src/lib/importers/`](src/lib/importers). Each one implements a small interface:

```ts
interface WorklistImporter {
  id: string;
  label: string;
  accept: string;                       // file types for the picker
  matches(file: File): boolean;
  read(file: File): Promise<ImportResult>;
}
```

Return `{ kind: 'table', … }` to get the column-mapping screen for free, or `{ kind: 'records', … }` when your source already knows which field is which (HL7 SIU, FHIR Appointment bundles, an EMR API). Add it to `IMPORTERS` in `index.ts` and it appears automatically. CSV and JSON importers are included as examples.

---

## Storage and file format

**Format: WebP at quality 92, by default.** WebP is roughly a third smaller than JPEG at the same visual quality. At 92 it is visually lossless for clinical review, and every modern browser, Windows Photos and macOS Preview open it. A full 5 MP Mizar frame is usually 0.5–1.5 MB. You can switch to JPEG (maximum compatibility) or PNG (lossless, 5–10× larger) in Settings, or keep the Canon's original JPEGs byte for byte with *Keep camera originals*.

**Archive folder layout.** It is readable without Lumen and ready for backup:

```
Archive/
  FITZGERALD_Eleanor_H100234/
    2026-11-03/
      H100234_20261103_143205_OD_slit.webp
      H100234_20261103_143212_OS_diffuse.webp
      visit.json         ← patient, visit and per-image metadata (eye, technique, time, notes)
```

- Photos are written to the archive the moment they're taken. If the folder is unavailable (network share down, or permission needed after a restart), photos are kept safely in the browser and synced when it's back. The top-bar pill shows the status and how many are waiting.
- The browser copy belongs to that browser profile on that PC. Treat the **archive folder as the record**: put it on backed-up storage.
- Encoding runs in a background thread, so the live view never stutters, even for large Canon files.

---

## Keyboard shortcuts

| Key | Action | Key | Action |
| --- | --- | --- | --- |
| Space | Capture (or your foot-switch key) | ↑ ↓ | Previous / next patient |
| R · L · B | Right (OD) · Left (OS) · Both (OU) | / | Search patients |
| 1 – 8 · 0 | Illumination technique · clear | V | Capture ⇄ Review |
| G | Centring reticle | F | Full-screen live view |
| ← → | Previous / next photo (viewer) | S · I · Del | Star · details · delete |

Press **?** in the app for the full list.

---

## Development

```
src/
  lib/            framework-free logic: CSV parsing, importers, dates & names, IndexedDB,
                  archive writer, folder watcher, encoder, ZIP, file naming
  state/          app state (zustand): store.ts, camera.ts, canon.ts (Camera Link client), keyboard actions
  components/     React UI
  styles/         design tokens (tokens.css), base controls, layout
  workers/        image encoder (OffscreenCanvas)
helper/           Lumen Camera Link: Node + koffi bindings to Canon's EDSDK, simulator, local server
tests/            unit tests (Vitest) and end-to-end tests (Playwright)
```

```bash
npm test            # unit tests: CSV, dates, names, column mapping, ZIP, database import
npm run typecheck
node tests/e2e/smoke.cjs   # with `npm start` running; needs Playwright + Chromium
node tests/e2e/canon.cjs   # after `npm run build`; starts the helper's simulated EOS 60D itself
cd helper && npm test      # runs the real Canon SDK bindings against a stand-in library (needs a C compiler)
```

The smoke test imports the sample list, captures from Chromium's fake camera, checks the archive files, and simulates a Canon shot landing in the tethered folder. The Canon test covers live view, changing settings, saving and applying presets, capture with exposure metadata, and the helper going away and coming back.

### Possible next steps

- **DICOM export** (VL Photographic Image) for PACS or Forum integration.
- HL7 / FHIR worklist import from the PAS.
- Annotation (arrows, measurements) and fluorescein grading overlays.
- Canon presets that also cover image quality and drive mode.
