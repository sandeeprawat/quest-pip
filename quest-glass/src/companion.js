import * as THREE from 'three';

const stateLabels = {
  connecting: 'Connecting to the Mac',
  idle: 'Ready · local only',
  requesting: 'Allow microphone access',
  listening: 'Listening · tap again to send',
  thinking: 'Thinking on your Mac',
  speaking: 'Speaking · tap to stop',
  error: 'Needs attention',
  unavailable: 'Local AI unavailable',
};
const stateColors = {
  connecting: 0x7e9aaa, idle: 0xb6f4cf, requesting: 0xffc36e,
  listening: 0xffb955, thinking: 0xac9dff, speaking: 0x6fdcff,
  error: 0xff8c82, unavailable: 0xff8c82,
};

function toBase64(bytes) {
  let binary = '';
  for (let offset = 0; offset < bytes.length; offset += 8192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
  }
  return btoa(binary);
}

export function createCompanion({ scene, getContext, onAction }) {
  const talkButton = document.querySelector('#companion-talk');
  const stateElement = document.querySelector('#companion-state');
  const errorElement = document.querySelector('#companion-error');
  const transcriptElement = document.querySelector('#companion-transcript');
  const replyElement = document.querySelector('#companion-reply');
  const form = document.querySelector('#companion-form');
  const input = document.querySelector('#companion-input');
  const submitButton = form.querySelector('button');
  const root = new THREE.Group();
  root.position.set(-0.3, 1.23, -0.5);
  scene.add(root);
  const body = new THREE.Mesh(
    new THREE.SphereGeometry(0.065, 32, 24),
    new THREE.MeshStandardMaterial({ color: 0xb6f4cf, emissive: 0x2a5a4a, roughness: 0.35, metalness: 0.15 }),
  );
  root.add(body);
  const eyes = new THREE.Group();
  const darkMaterial = new THREE.MeshBasicMaterial({ color: 0x152f37 });
  for (const x of [-0.022, 0.022]) {
    const eye = new THREE.Mesh(new THREE.SphereGeometry(0.008, 12, 8), darkMaterial);
    eye.position.set(x, 0.012, 0.061);
    eyes.add(eye);
  }
  const mouth = new THREE.Mesh(new THREE.SphereGeometry(0.009, 12, 8), darkMaterial);
  mouth.position.set(0, -0.019, 0.063);
  mouth.scale.set(1, 0.3, 0.3);
  eyes.add(mouth);
  root.add(eyes);
  const orbit = new THREE.Mesh(
    new THREE.TorusGeometry(0.09, 0.002, 8, 48),
    new THREE.MeshBasicMaterial({ color: 0xb6f4cf }),
  );
  orbit.rotation.x = Math.PI / 2.5;
  root.add(orbit);

  const canvas = document.createElement('canvas');
  canvas.width = 1024;
  canvas.height = 512;
  const context = canvas.getContext('2d');
  if (!context) throw new Error('The companion needs a 2D canvas for its speech panel.');
  const texture = new THREE.CanvasTexture(canvas);
  texture.colorSpace = THREE.SRGBColorSpace;
  const speechPanel = new THREE.Mesh(
    new THREE.PlaneGeometry(0.49, 0.245),
    new THREE.MeshBasicMaterial({ map: texture, transparent: true, side: THREE.DoubleSide }),
  );
  speechPanel.position.y = -0.225;
  root.add(speechPanel);

  let state = 'connecting';
  let ready = false;
  let recorder;
  let stream;
  let recordingTimer;
  let generation = 0;
  let requestController;
  let audioContext;
  let audioSource;
  let history = [];
  let transcript = '';
  let reply = 'Hi, I am Pip. Tap me to talk.';
  let panelDirty = true;
  let positionInXR = false;
  const canRecord = Boolean(navigator.mediaDevices?.getUserMedia && window.MediaRecorder);

  function drawText(text, y, maxLines, color) {
    context.fillStyle = color;
    context.font = '32px sans-serif';
    const words = text.split(/\s+/);
    const lines = [];
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (context.measureText(next).width > 920 && line) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
    lines.slice(0, maxLines).forEach((value, index) => {
      context.fillText(index === maxLines - 1 && lines.length > maxLines ? `${value}…` : value, 52, y + index * 42);
    });
  }

  function drawPanel() {
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = 'rgba(12, 27, 38, 0.95)';
    context.beginPath();
    context.roundRect(0, 0, 1024, 512, 32);
    context.fill();
    context.fillStyle = `#${stateColors[state].toString(16).padStart(6, '0')}`;
    context.font = 'bold 30px sans-serif';
    context.fillText(`PIP / ${stateLabels[state].toUpperCase()}`, 52, 60);
    drawText(state === 'error' || state === 'unavailable' ? errorElement.textContent : reply, 125, 5, '#eef7fb');
    drawText(transcript ? `You: ${transcript}` : 'Aim here and pinch / trigger to start or stop recording.', 365, 2, '#9eb6c5');
    texture.needsUpdate = true;
    panelDirty = false;
  }

  function setState(next) {
    state = next;
    stateElement.textContent = stateLabels[state];
    stateElement.dataset.state = state;
    const busy = ['requesting', 'listening', 'thinking', 'speaking'].includes(state);
    talkButton.disabled = !ready || !canRecord;
    talkButton.textContent = state === 'listening' ? 'Finish & send'
      : busy ? 'Cancel / stop' : 'Talk to Pip';
    talkButton.setAttribute('aria-pressed', String(state === 'listening'));
    input.disabled = submitButton.disabled = !ready || busy;
    body.material.color.setHex(stateColors[state]);
    orbit.material.color.setHex(stateColors[state]);
    panelDirty = true;
  }

  function stopTracks() {
    clearTimeout(recordingTimer);
    stream?.getTracks().forEach((track) => track.stop());
    stream = undefined;
  }

  function cancel() {
    generation++;
    requestController?.abort();
    requestController = undefined;
    if (recorder?.state === 'recording') recorder.stop();
    stopTracks();
    if (audioSource) {
      audioSource.onended = null;
      audioSource.stop();
      audioSource = undefined;
    }
    setState(ready ? 'idle' : 'unavailable');
  }

  function fail(error) {
    console.error('Companion:', error);
    errorElement.hidden = false;
    errorElement.textContent = error.message || 'The companion could not complete this turn.';
    setState('error');
  }

  async function prepareAudio() {
    if (!audioContext) audioContext = new AudioContext();
    if (audioContext.state !== 'running') await audioContext.resume();
  }

  async function send(path, payload, token) {
    setState('thinking');
    requestController = new AbortController();
    const timeout = setTimeout(() => requestController?.abort(new Error('Local AI timed out. Try again.')), 180_000);
    try {
      const response = await fetch(`/api/companion/${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ ...payload, history, context: getContext() }),
        signal: requestController.signal,
      });
      const result = await response.json();
      if (token !== generation) return;
      if (!response.ok) throw new Error(result.error || 'The local companion could not answer.');
      if (typeof result.text !== 'string' || typeof result.transcript !== 'string'
        || typeof result.audio !== 'string') throw new Error('The companion returned an incomplete reply.');
      onAction(result.action);
      transcript = result.transcript;
      reply = result.text;
      transcriptElement.textContent = transcript;
      replyElement.textContent = reply;
      history = [...history,
        { role: 'user', content: transcript }, { role: 'assistant', content: reply },
      ].slice(-8);
      panelDirty = true;
      const binary = atob(result.audio);
      const bytes = Uint8Array.from(binary, (character) => character.charCodeAt(0));
      const buffer = await audioContext.decodeAudioData(bytes.buffer);
      if (token !== generation) return;
      audioSource = audioContext.createBufferSource();
      audioSource.buffer = buffer;
      audioSource.connect(audioContext.destination);
      audioSource.onended = () => {
        audioSource = undefined;
        if (token === generation) setState('idle');
      };
      setState('speaking');
      audioSource.start();
    } finally {
      clearTimeout(timeout);
      if (token === generation) requestController = undefined;
    }
  }

  async function startRecording() {
    const token = ++generation;
    errorElement.hidden = true;
    setState('requesting');
    try {
      await prepareAudio();
      if (token !== generation) return;
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true },
      });
      if (token !== generation) {
        acquired.getTracks().forEach((track) => track.stop());
        return;
      }
      stream = acquired;
      const mimeType = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
        .find((type) => MediaRecorder.isTypeSupported(type));
      recorder = new MediaRecorder(stream, mimeType ? { mimeType } : undefined);
      const chunks = [];
      const started = performance.now();
      recorder.ondataavailable = (event) => {
        if (event.data.size) chunks.push(event.data);
      };
      recorder.onerror = (event) => {
        cancel();
        fail(event.error || new Error('Microphone recording failed.'));
      };
      recorder.onstop = async () => {
        stopTracks();
        if (token !== generation) return;
        try {
          if (performance.now() - started < 350) throw new Error('Recording was too short. Try a complete sentence.');
          const blob = new Blob(chunks, { type: recorder.mimeType });
          if (!blob.size) throw new Error('The microphone produced no audio. Check its permission and input.');
          const audio = toBase64(new Uint8Array(await blob.arrayBuffer()));
          if (token !== generation) return;
          await send('talk', { audio }, token);
        } catch (error) {
          if (token === generation) fail(error);
        }
      };
      recorder.start();
      setState('listening');
      recordingTimer = setTimeout(() => {
        if (recorder.state === 'recording') recorder.stop();
      }, 20_000);
    } catch (error) {
      stopTracks();
      if (token === generation) {
        fail(new Error(`Microphone could not start: ${error.message}. Allow microphone access for this site.`));
      }
    }
  }

  function toggle() {
    if (!ready) {
      errorElement.hidden = false;
      panelDirty = true;
      return;
    }
    if (state === 'listening') {
      if (recorder?.state === 'recording') recorder.stop();
    } else if (['requesting', 'thinking', 'speaking'].includes(state)) {
      cancel();
    } else if (!canRecord) {
      fail(new Error('This browser cannot record audio. Use Meta Quest Browser over HTTPS, or type below.'));
    } else {
      void startRecording();
    }
  }

  talkButton.addEventListener('click', toggle);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const text = input.value.trim();
    if (!ready || !text || ['requesting', 'listening', 'thinking', 'speaking'].includes(state)) return;
    const token = ++generation;
    errorElement.hidden = true;
    setState('thinking');
    try {
      await prepareAudio();
      if (token !== generation) return;
      input.value = '';
      await send('chat', { text }, token);
    } catch (error) {
      if (token === generation) fail(error);
    }
  });
  document.querySelector('#companion-check').addEventListener('click', () => { void checkConnection(); });

  async function checkConnection() {
    ready = false;
    cancel();
    const token = generation;
    setState('connecting');
    errorElement.hidden = true;
    try {
      const response = await fetch('/api/companion/status', { signal: AbortSignal.timeout(10_000) });
      const result = await response.json();
      if (token !== generation) return;
      if (!response.ok || !result.ready) throw new Error(result.error || 'Local AI is not ready.');
      ready = true;
      setState('idle');
    } catch (error) {
      if (token !== generation) return;
      ready = false;
      fail(error);
      setState('unavailable');
    }
  }

  setState('connecting');
  void checkConnection();
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) cancel();
  });
  window.addEventListener('pagehide', cancel);

  return {
    root,
    select(raycaster) {
      if (!raycaster.intersectObject(root, true).length) return false;
      toggle();
      return true;
    },
    enterXR() { positionInXR = true; },
    leaveXR() {
      cancel();
      positionInXR = false;
      root.position.set(-0.3, 1.23, -0.5);
    },
    update(time, headPosition, headQuaternion, hasXRPose) {
      if (positionInXR && hasXRPose) {
        root.position.set(0.46, -0.12, -0.95).applyQuaternion(headQuaternion).add(headPosition);
        positionInXR = false;
      }
      root.lookAt(headPosition);
      body.position.y = eyes.position.y = Math.sin(time * 0.0015) * 0.006;
      orbit.rotation.z = time * 0.0004;
      mouth.scale.y = state === 'speaking' ? 0.3 + Math.abs(Math.sin(time * 0.015)) * 0.9 : 0.3;
      const pulse = state === 'listening' || state === 'thinking' ? 1 + Math.sin(time * 0.006) * 0.06 : 1;
      body.scale.setScalar(pulse);
      if (panelDirty) drawPanel();
    },
  };
}
