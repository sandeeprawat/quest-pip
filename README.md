# Pip for Meta Quest

A mixed-reality companion prototype for Meta Quest 3 / 3S. Talk to Pip, ask it to
identify a centered object, and request that it pick up or throw a **virtual copy**.
Physical objects stay untouched.

| Directory | Contents |
| --- | --- |
| `quest-glass-native/` | Unity app, based on Meta's official Passthrough Camera API samples |
| `quest-glass/` | Local speech/vision backend and the original WebXR glass demo |

The native APK has been built locally, but camera, depth, and interaction behavior
have **not yet been verified on a headset**. Proxies are approximate procedural
shapes, with one active object at a time; this is not exact 3D reconstruction.

## Local AI setup on macOS

AI runs on the Mac, not on the headset. Keep both devices on the same trusted LAN
and keep the Mac awake. No cloud API key is required.

Install Node.js/npm and the local runtime tools:

```sh
brew install ollama whisper-cpp ffmpeg
ollama serve
```

In another terminal:

```sh
ollama pull qwen3:4b
ollama pull qwen2.5vl:7b
cd quest-glass
npm ci
mkdir -p .local/models
curl --fail --location \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-base.en.bin \
  --output .local/models/ggml-base.en.bin
npm run dev
```

The backend uses Whisper for English speech recognition, Qwen 3 for browser chat,
Qwen 2.5 VL for native vision/conversation, and macOS `say` for spoken replies.
The development server listens on HTTPS port 5173. Do not expose it to the public
internet; the prototype is intended for a trusted local network.

## Build the Quest app

1. Install Unity with Android Build Support and activate a Unity license.
   The project's editor version is recorded in
   `quest-glass-native/ProjectSettings/ProjectVersion.txt`.
2. Keep the local HTTPS backend running so its development certificate exists.
3. Open `quest-glass-native` in Unity and select **Pip > Create Companion Scene**.
4. On the scene's **Pip Companion** object, set **Server Url** to
   `https://<YOUR_MAC_LAN_IP>:5173`. Scene generation sets the SHA-256 pin for
   your local certificate. The checked-in runtime URL is only a localhost
   placeholder, not a usable headset destination.
5. Select **Pip > Build Quest APK**. The output is
   `quest-glass-native/Builds/PipCompanion.apk`.

The generated companion scene is intentionally ignored: it contains local server
configuration. If the certificate changes, regenerate the scene, set the server
URL again, and rebuild.

Enable Quest developer mode, connect by USB, authorize debugging, and install:

```sh
cd quest-glass-native
npx --yes @meta-quest/hzdb app install -r Builds/PipCompanion.apk
```

Launch **Pip Mixed Reality**, allow camera/microphone/spatial permissions, and
center an object on the `+`. Press **A** or pinch an index finger to record; repeat
to send. **X** cancels. Try "pick up this pen", then "throw it".

The browser demo cannot inspect passthrough camera pixels; automatic camera-based
identification is a native-app feature.

## Development

```sh
cd quest-glass
npm test
npm run build
```

Browser interaction tests use Playwright (`npm run test:browser`) and require its
Chromium installation.

## Repository hygiene and upstream notices

Do not commit credentials, private keys, development certificates, signing
keystores, `.env` files, downloaded local AI models, recordings, camera snapshots,
Unity caches, or build outputs. Ignore rules exclude the known local artifacts;
review staged changes and run a secret scanner before pushing.

The Unity project derives from
[Meta's Unity-PassthroughCameraApiSamples](https://github.com/oculus-samples/Unity-PassthroughCameraApiSamples).
Its original license files, attribution, and file-level notices are preserved
under `quest-glass-native/`. Those notices govern the upstream material; this
repository does not relicense it.
