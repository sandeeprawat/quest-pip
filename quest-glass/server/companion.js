import { execFile } from 'node:child_process';
import { access, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);
const modelPath = fileURLToPath(new URL('../.local/models/ggml-base.en.bin', import.meta.url));
const chatModel = 'qwen3:4b';
const visionModel = 'qwen2.5vl:7b';
const ollamaUrl = 'http://127.0.0.1:11434';
const maxBodyBytes = 2 * 1024 * 1024;
const actions = ['none', 'pick_up_glass', 'throw_glass', 'put_down_glass'];
const replySchema = {
  type: 'object',
  properties: { text: { type: 'string' }, action: { type: 'string', enum: actions } },
  required: ['text', 'action'],
  additionalProperties: false,
};
const systemPrompt = `You are Pip, a friendly floating companion in a Quest mixed-reality glass demo.
Have a natural conversation. Answer in at most two short sentences, in plain spoken English without Markdown.
You cannot see the room or recognize real objects. Never claim to manipulate physical objects.
The user can mark a real glass, grab a virtual cup with a pinch or trigger, and tilt it near their mouth to simulate drinking.
You can request ONLY these virtual app actions: pick_up_glass, throw_glass, put_down_glass.
There is exactly one virtual glass: "this glass", "the cup", and "it" refer to that virtual glass.
For a request to pick it up AND throw it, use throw_glass: that action automatically picks it up first.
Use none for questions, hypothetical discussion, physical-object requests, and unrelated chat. Never throw just because throwing was mentioned.
Only request an action when glassAvailable is true and glassHeldByUser is false.
For an unavailable glass, explain that the user should place the virtual glass first; if held by the user, ask them to release it.
Respond with JSON containing text and action. For actions, say what you WILL do, not that it has already happened.
Remind them to leave the real glass on the table when relevant. Never tell them to drink or grab the real glass while wearing the headset.`;
const objectActions = ['none', 'pick_up_object', 'throw_object', 'put_down_object'];
const shapes = ['pen', 'cup', 'bottle', 'book', 'box', 'generic'];
const nativeSchema = {
  type: 'object',
  properties: {
    text: { type: 'string' },
    action: { type: 'string', enum: objectActions },
    target: {
      type: 'object',
      properties: {
        label: { type: 'string' }, shape: { type: 'string', enum: shapes }, useExisting: { type: 'boolean' },
        xMin: { type: 'number' }, yMin: { type: 'number' },
        xMax: { type: 'number' }, yMax: { type: 'number' },
      },
      required: ['label', 'shape', 'useExisting', 'xMin', 'yMin', 'xMax', 'yMax'],
      additionalProperties: false,
    },
  },
  required: ['text', 'action', 'target'], additionalProperties: false,
};
const nativePrompt = `You are Pip, a friendly mixed-reality companion. You receive a headset camera snapshot, a spoken request, and the current virtual-object state.
Reply as JSON matching the schema. text is at most two short, plain spoken English sentences.
You can manipulate ONLY VIRTUAL PROXIES, never real objects. Never imply that a physical object moves or vanishes.
Actions are none, pick_up_object, throw_object, put_down_object. A combined "pick up and throw" request uses throw_object.
Only act on an explicit request. Questions and hypothetical discussion use none.
For a NEW object, identify the requested visible object and its tight bounding box in the image.
Coordinates are 0 to 1000, with (0,0) at top left and (1000,1000) at bottom right.
The user must center the requested object on the aiming reticle at (500,500). If it does not contain that point or you cannot identify it confidently, use none and ask them to center it or clarify.
When there are multiple possible objects, ask for clarification instead of guessing.
Use pen, cup, bottle, book, or box for a recognizable proxy shape; otherwise use generic. label is the short common name of the object.
A pronoun alone ("it" or "this") refers to the current virtual object, if any. Set useExisting true and use its label and shape from the supplied state. An explicitly named different object or a request for a NEW object should identify a visible target with useExisting false.
For a put-down request with no existing virtual object, use none.
For no action use target with label "", shape generic, useExisting false, and all coordinates 0.
For an action say what you WILL do to its virtual copy, not that it has already happened.
You have no filesystem, shell, smart-home or physical-robot controls. Never claim access to any.`;

export class RequestError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function validateConversation(body) {
  if (!body || typeof body !== 'object' || Array.isArray(body)) {
    throw new RequestError(400, 'Expected a JSON object.');
  }
  const history = body.history ?? [];
  if (!Array.isArray(history) || history.length > 8 || history.length % 2 !== 0) {
    throw new RequestError(400, 'Conversation history must contain at most four complete turns.');
  }
  for (const [index, message] of history.entries()) {
    if (!message || message.role !== (index % 2 === 0 ? 'user' : 'assistant')
      || typeof message.content !== 'string' || !message.content.trim() || message.content.length > 2000) {
      throw new RequestError(400, 'Conversation history contains an invalid message.');
    }
  }
  return history.map(({ role, content }) => ({ role, content }));
}

export function decodeRecording(body) {
  if (typeof body.audio !== 'string' || body.audio.length < 16
    || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(body.audio)) {
    throw new RequestError(400, 'A base64-encoded audio recording is required.');
  }
  const audio = Buffer.from(body.audio, 'base64');
  if (audio.length > 1.5 * 1024 * 1024) throw new RequestError(413, 'Recording is too large. Keep it under 20 seconds.');
  return audio;
}

export function validateContext(context) {
  if (!context || ['glassAvailable', 'glassHeldByUser', 'glassHeldByCompanion']
    .some((key) => typeof context[key] !== 'boolean')) {
    throw new RequestError(400, 'The virtual glass state is required.');
  }
  return {
    glassAvailable: context.glassAvailable,
    glassHeldByUser: context.glassHeldByUser,
    glassHeldByCompanion: context.glassHeldByCompanion,
  };
}

export function parseReply(content, context) {
  let reply;
  try {
    reply = JSON.parse(content);
  } catch {
    throw new RequestError(502, 'The local AI returned an invalid action. Please retry.');
  }
  if (typeof reply?.text !== 'string' || !reply.text.trim() || reply.text.length > 2000
    || !actions.includes(reply.action)) {
    throw new RequestError(502, 'The local AI returned an unsupported action or invalid reply.');
  }
  if (reply.action !== 'none' && (!context.glassAvailable || context.glassHeldByUser)) {
    throw new RequestError(409, context.glassHeldByUser
      ? 'Release your virtual cup before asking Pip to move it.'
      : 'Place the virtual glass before asking Pip to move it.');
  }
  const actionText = {
    pick_up_glass: 'I will pick up the virtual cup.',
    throw_glass: 'I will pick up the virtual cup and throw it.',
    put_down_glass: 'I will put the virtual cup back where it started.',
  };
  return { text: actionText[reply.action] ?? reply.text.trim(), action: reply.action };
}

export function validateNativeContext(context) {
  if (!context || typeof context.hasObject !== 'boolean'
    || typeof context.label !== 'string' || context.label.length > 80
    || !shapes.includes(context.shape)) {
    throw new RequestError(400, 'A valid current virtual-object state is required.');
  }
  return { hasObject: context.hasObject, label: context.label, shape: context.shape };
}

export function decodeCameraImage(image) {
  if (typeof image !== 'string' || image.length > 900_000) {
    throw new RequestError(400, 'A JPEG camera snapshot smaller than 650 KB is required.');
  }
  let bytes;
  try {
    bytes = decodeRecording({ audio: image });
  } catch {
    throw new RequestError(400, 'The camera snapshot is not valid base64.');
  }
  if (bytes[0] !== 0xff || bytes[1] !== 0xd8 || bytes[2] !== 0xff) {
    throw new RequestError(400, 'The camera snapshot must be JPEG.');
  }
  return bytes.toString('base64');
}

export function parseNativeReply(content, context) {
  let result;
  try {
    result = JSON.parse(content);
  } catch {
    throw new RequestError(502, 'The vision model returned invalid JSON. Please retry.');
  }
  if (!result || typeof result.text !== 'string' || !result.text.trim() || result.text.length > 2000
    || !objectActions.includes(result.action)) {
    throw new RequestError(502, 'The vision model returned an invalid object action.');
  }
  if (result.action === 'none') return { text: result.text.trim(), action: 'none', target: null };
  const target = result.target;
  if (!target || typeof target.label !== 'string' || !target.label.trim() || target.label.length > 80
    || !shapes.includes(target.shape)) throw new RequestError(502, 'The vision model did not identify a valid object.');
  if (typeof target.useExisting !== 'boolean') throw new RequestError(502, 'The vision model did not specify which object to use.');
  const existing = target.useExisting && context.hasObject && target.label.toLowerCase() === context.label.toLowerCase();
  if (target.useExisting && !existing) throw new RequestError(409, 'That virtual object is no longer available. Center the real object and ask again.');
  if (!existing) {
    const box = [target.xMin, target.yMin, target.xMax, target.yMax];
    if (box.some((value) => !Number.isFinite(value) || value < 0 || value > 1000)
      || target.xMin >= target.xMax || target.yMin >= target.yMax) {
      throw new RequestError(502, 'The vision model returned an invalid object location.');
    }
    if (target.xMin > 500 || target.xMax < 500 || target.yMin > 500 || target.yMax < 500) {
      throw new RequestError(422, 'Center the requested object in the aiming reticle, then ask again.');
    }
    if (result.action === 'put_down_object') throw new RequestError(409, 'Pip is not holding a virtual copy of that object.');
  }
  const label = target.label.trim();
  const text = result.action === 'pick_up_object'
    ? `I will pick up ${existing ? 'the virtual' : 'a virtual copy of the'} ${label}.`
    : result.action === 'throw_object'
      ? existing ? `I will throw the virtual ${label}.` : `I will make a virtual copy of the ${label}, pick it up, and throw it.`
      : `I will put the virtual ${label} back where it started.`;
  return { text, action: result.action, target: { ...target, label } };
}

async function executable(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!directory) continue;
    const path = join(directory, name);
    try {
      await access(path, constants.X_OK);
      return path;
    } catch (error) {
      if (error.code !== 'ENOENT' && error.code !== 'EACCES') throw error;
    }
  }
  throw new RequestError(503, `${name} is missing on the Mac. Install the local voice tools first.`);
}

async function run(command, args, label, signal) {
  try {
    return await execFileAsync(command, args, {
      timeout: 60_000, maxBuffer: 1024 * 1024, signal,
    });
  } catch (error) {
    if (signal.aborted) throw error;
    console.error(`${label} failed:`, error.stderr || error.message);
    throw new RequestError(502, `${label} failed on the Mac. Check the local server output.`);
  }
}

async function getTools() {
  const [whisper, ffmpeg, say] = await Promise.all([
    executable('whisper-cli'), executable('ffmpeg'), executable('say'),
  ]);
  try {
    await access(modelPath, constants.R_OK);
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
    throw new RequestError(503, 'The local Whisper speech model has not been downloaded.');
  }
  return { whisper, ffmpeg, say };
}

export const localEngine = {
  async status() {
    await getTools();
    let response;
    try {
      response = await fetch(`${ollamaUrl}/api/tags`, { signal: AbortSignal.timeout(3000) });
    } catch (error) {
      console.error('Ollama availability check failed:', error.message);
      throw new RequestError(503, 'Ollama is not running on the Mac. Start it with ollama serve.');
    }
    if (!response.ok) throw new RequestError(503, 'Ollama could not list its local models.');
    const data = await response.json();
    for (const modelName of [chatModel, visionModel]) {
      if (!data.models?.some((model) => model.name === modelName)) {
        throw new RequestError(503, `The local AI model is missing. Run ollama pull ${modelName} on the Mac.`);
      }
    }
    return { ready: true, provider: 'local', model: chatModel, visionModel };
  },

  async reply(body, audio, signal) {
    const history = validateConversation(body);
    const native = body.native === true;
    const context = native ? validateNativeContext(body.context) : validateContext(body.context);
    const image = native ? decodeCameraImage(body.image) : null;
    let transcript = body.text;
    if (!audio && (typeof transcript !== 'string' || !transcript.trim() || transcript.length > 1000)) {
      throw new RequestError(400, 'Enter a message between 1 and 1000 characters.');
    }
    const tools = await getTools();
    const directory = await mkdtemp(join(tmpdir(), 'quest-voice-'));
    try {
      if (audio) {
        const recording = join(directory, 'recording.audio');
        const wav = join(directory, 'recording.wav');
        const transcriptPath = join(directory, 'transcript');
        await writeFile(recording, audio);
        await run(tools.ffmpeg, [
          '-hide_banner', '-loglevel', 'error', '-nostdin', '-y',
          '-protocol_whitelist', 'file,pipe', '-format_whitelist', 'wav,matroska,webm,mov,ogg', '-i', recording,
          '-t', '20', '-ar', '16000', '-ac', '1', '-c:a', 'pcm_s16le', wav,
        ], 'Audio conversion', signal);
        await run(tools.whisper, [
          '-m', modelPath, '-f', wav, '-l', 'en', '-oj', '-of', transcriptPath, '-np',
        ], 'Speech recognition', signal);
        const result = JSON.parse(await readFile(`${transcriptPath}.json`, 'utf8'));
        if (!Array.isArray(result.transcription)) throw new Error('Whisper returned an invalid transcript.');
        transcript = result.transcription.map((segment) => segment.text).join(' ').trim();
        if (!transcript || /^\s*(\[[^\]]*\]|\([^)]*\))\s*$/.test(transcript)) {
          throw new RequestError(422, 'No speech was recognized. Try a short sentence closer to the microphone.');
        }
        if (transcript.length > 1000) throw new RequestError(413, 'Recognized speech is too long. Try a shorter sentence.');
      }
      let response;
      try {
        response = await fetch(`${ollamaUrl}/api/chat`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            model: native ? visionModel : chatModel,
            stream: false, ...(native ? {} : { think: false }), keep_alive: '10m', format: native ? nativeSchema : replySchema,
            messages: [
              { role: 'system', content: `${native ? nativePrompt : systemPrompt}\nCurrent app state: ${JSON.stringify(context)}` },
              ...history,
              { role: 'user', content: transcript.trim(), ...(image ? { images: [image] } : {}) },
            ],
            options: { num_predict: 160, num_ctx: 4096, temperature: 0.6 },
          }),
          signal: AbortSignal.any([signal, AbortSignal.timeout(90_000)]),
        });
      } catch (error) {
        if (signal.aborted) throw error;
        console.error('Local conversation failed:', error.message);
        throw new RequestError(503, 'The local AI did not respond. Check that Ollama is running on the Mac.');
      }
      if (!response.ok) throw new RequestError(502, `Ollama rejected the conversation. Check that ${native ? visionModel : chatModel} is downloaded.`);
      const result = await response.json();
      const { text, action, target = null } = native
        ? parseNativeReply(result.message?.content, context) : parseReply(result.message?.content, context);
      const speechText = join(directory, 'reply.txt');
      const aiff = join(directory, 'reply.aiff');
      const replyWav = join(directory, 'reply.wav');
      await writeFile(speechText, text);
      await run(tools.say, ['-r', '185', '-o', aiff, '-f', speechText], 'Speech synthesis', signal);
      await run(tools.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-nostdin', '-y', '-i', aiff,
        '-ar', '24000', '-ac', '1', '-c:a', 'pcm_s16le', replyWav,
      ], 'Speech playback conversion', signal);
      return {
        transcript: transcript.trim(), text, action, target,
        audio: (await readFile(replyWav)).toString('base64'), mimeType: 'audio/wav',
      };
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  },
};

async function readJson(request) {
  if (!request.headers['content-type']?.startsWith('application/json')) {
    throw new RequestError(415, 'Use an application/json request.');
  }
  let length = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += chunk.length;
    if (length > maxBodyBytes) {
      request.resume();
      throw new RequestError(413, 'Recording is too large. Keep it under 20 seconds.');
    }
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw new RequestError(400, 'The request contains invalid JSON.');
  }
}

export function createCompanionMiddleware(engine = localEngine) {
  let busy = false;
  return async (request, response, next) => {
    const path = request.url?.split('?')[0];
    if (!path?.startsWith('/api/companion/')) return next();
    const send = (status, data) => {
      if (response.destroyed) return;
      response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
      response.end(JSON.stringify(data));
    };
    const abort = new AbortController();
    response.on('close', () => {
      if (!response.writableEnded) abort.abort();
    });
    let ownsLock = false;
    try {
      const origin = request.headers.origin;
      const expectedOrigin = `${request.socket.encrypted ? 'https' : 'http'}://${request.headers.host}`;
      if (origin && origin !== expectedOrigin) throw new RequestError(403, 'Companion requests must come from this app.');
      if (path === '/api/companion/status' && request.method === 'GET') {
        send(200, await engine.status());
        return;
      }
      if (!['/api/companion/talk', '/api/companion/chat', '/api/companion/native'].includes(path)) throw new RequestError(404, 'Unknown companion endpoint.');
      if (request.method !== 'POST') throw new RequestError(405, 'Use POST for companion messages.');
      if (busy) throw new RequestError(429, 'Pip is already answering. Wait for the current conversation turn.');
      busy = ownsLock = true;
      const body = await readJson(request);
      validateConversation(body);
      body.native = path.endsWith('/native');
      if (body.native) {
        validateNativeContext(body.context);
        decodeCameraImage(body.image);
      } else {
        validateContext(body.context);
      }
      const audio = path.endsWith('/talk') || (body.native && body.audio !== undefined) ? decodeRecording(body) : null;
      send(200, await engine.reply(body, audio, abort.signal));
    } catch (error) {
      if (!abort.signal.aborted) {
        console.error('Companion request failed:', error);
        send(error instanceof RequestError ? error.status : 500, {
          error: error instanceof RequestError ? error.message : 'The local companion failed. Check the server output.',
        });
      }
    } finally {
      if (ownsLock) busy = false;
    }
  };
}

export function companionPlugin() {
  return {
    name: 'local-voice-companion',
    configureServer(server) { server.middlewares.use(createCompanionMiddleware()); },
    configurePreviewServer(server) { server.middlewares.use(createCompanionMiddleware()); },
  };
}
