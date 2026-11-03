# Put Canon's SDK here

Unzip the EDSDK you downloaded from Canon into **this folder**, keeping Canon's own folder names. For example:

```
helper/sdk/
  README.md                         ← this file
  EDSDK_v13.x.x_Win/                ← Windows download, as unzipped
    EDSDK/Header/EDSDK.h
    EDSDK_64/Dll/EDSDK.dll          ← the helper uses this 64-bit one
    EDSDK_64/Dll/EdsImage.dll
  EDSDK_v13.x.x_Mac/                ← Mac download, as unzipped (optional)
    EDSDK/Header/EDSDK.h
    EDSDK/Framework/EDSDK.framework
```

The exact layout doesn't matter. The helper searches this folder for `EDSDK.dll` (Windows) or `EDSDK.framework` (Mac), and reads `EDSDK.h` to tell whether the SDK is version 3.x or 13.x. You can keep both the Windows and Mac downloads here at the same time.

**Everything in this folder except this README is excluded from git.** Canon licenses the SDK to you, and this repository is public, so the SDK files must never be committed. Each computer that runs the helper needs its own copy in this folder.

## Which version for the EOS 60D?

- Start with the version you have. When the helper starts, its window shows which SDK it found. If the camera connects, Lumen shows "Canon EOS 60D" under **Camera source**.
- If Lumen instead says *"This version of the Canon SDK does not support this camera"*, the newest SDK has dropped the 60D. Ask Canon's developer programme for an older **EDSDK 3.x** release, unzip it here, and remove the newer one. The helper adjusts to 3.x automatically.
- **Mac with Apple Silicon (M1–M4):** you need an EDSDK build with Apple Silicon support (recent 13.x releases). Older Intel-only SDKs only load if Node itself runs under Rosetta.

## Somewhere else?

To keep the SDK in another folder, start the helper with `--sdk /path/to/EDSDK`, or set the `EDSDK_PATH` environment variable.
