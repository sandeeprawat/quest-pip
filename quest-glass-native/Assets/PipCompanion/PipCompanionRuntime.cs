using System;
using System.Collections;
using System.Collections.Generic;
using System.Security.Cryptography;
using System.Text;
using Meta.XR;
using UnityEngine;
using UnityEngine.Networking;
#if UNITY_ANDROID
using UnityEngine.Android;
#endif

namespace PipCompanion
{
    public sealed class PipCompanionRuntime : MonoBehaviour
    {
        public string ServerUrl = "https://localhost:5173";
        public string ServerCertificateSha256 = "";
        public PassthroughCameraAccess CameraAccess;
        public EnvironmentRaycastManager EnvironmentRaycaster;

        [Serializable] public sealed class Message { public string role; public string content; }
        [Serializable] public sealed class ObjectContext { public bool hasObject; public string label = ""; public string shape = "generic"; }
        [Serializable] public sealed class VoiceRequest { public string audio; public string image; public Message[] history; public ObjectContext context; }
        [Serializable] public sealed class Target { public string label; public string shape; public bool useExisting; public float xMin; public float yMin; public float xMax; public float yMax; }
        [Serializable] public sealed class Reply { public string transcript; public string text; public string audio; public string action; public Target target; public string error; }

        private readonly List<Message> history = new();
        private readonly ObjectContext objectContext = new();
        private Transform head;
        private GameObject pip;
        private Renderer pipRenderer;
        private TextMesh panel;
        private Transform reticle;
        private AudioSource speaker;
        private AudioClip recording;
        private UnityWebRequest activeRequest;
        private Coroutine conversation;
        private Coroutine actionRoutine;
        private GameObject proxy;
        private Vector3 proxyHome;
        private Vector3 snapshotPoint;
        private bool snapshotHasDepth;
        private bool recordingActive;
        private bool busy;
        private bool initialized;
        private float recordingStarted;
        private string state = "Starting";
        private string detail = "";
        private string lastReply = "Hi, I am Pip. Center an object and ask me about its virtual copy.";
        private string lastTranscript = "";
        private static readonly Color IdleColor = new(0.65f, 0.96f, 0.8f);

        private IEnumerator Start()
        {
            var rig = FindFirstObjectByType<OVRCameraRig>();
            if (rig == null || CameraAccess == null || EnvironmentRaycaster == null)
            {
                Debug.LogError("Pip needs a camera rig, passthrough camera access, and environment raycasting.");
                enabled = false;
                yield break;
            }
            head = rig.centerEyeAnchor;
            CreateCompanion();
            Show("Permissions", "Allow camera, microphone, and spatial-data access. Audio and one snapshot are sent only to your Mac when you send a turn.");
#if UNITY_ANDROID && !UNITY_EDITOR
            Permission.RequestUserPermissions(new[]
            {
                Permission.Microphone, "horizonos.permission.HEADSET_CAMERA", "com.oculus.permission.USE_SCENE"
            });
#endif
            var deadline = Time.realtimeSinceStartup + 60;
            while (!CameraAccess.IsPlaying && Time.realtimeSinceStartup < deadline) yield return null;
            if (!CameraAccess.IsPlaying)
            {
                ShowError("Camera access did not start. Grant the headset camera permission in app settings, then restart.");
                yield break;
            }
            if (!EnvironmentRaycastManager.IsSupported)
            {
                ShowError("Environment depth is unsupported. This app requires Quest 3 / 3S and compatible Horizon OS.");
                yield break;
            }
            if (!Uri.TryCreate(ServerUrl, UriKind.Absolute, out var server) || server.Scheme != "https"
                || !IsCertificatePinValid(ServerCertificateSha256))
            {
                ShowError("Set the Mac HTTPS URL and its 64-character certificate fingerprint in the Pip scene.");
                yield break;
            }
            pip.transform.position = head.TransformPoint(new Vector3(0.35f, -0.02f, 0.8f));
            initialized = true;
            Show("Ready", "Center a real object in the +. Press A or pinch an index finger to record; repeat to send. Leave real objects untouched.");
        }

        private static bool IsCertificatePinValid(string pin)
        {
            if (pin == null || pin.Length != 64) return false;
            foreach (var character in pin) if (!Uri.IsHexDigit(character)) return false;
            return true;
        }

        private void CreateCompanion()
        {
            pip = new GameObject("Pip - virtual companion");
            var body = CreatePart(PrimitiveType.Sphere, pip.transform, Vector3.zero, Vector3.one * 0.13f, IdleColor);
            pipRenderer = body.GetComponent<Renderer>();
            for (var index = -1; index <= 1; index += 2)
                CreatePart(PrimitiveType.Sphere, pip.transform, new Vector3(index * 0.022f, 0.012f, -0.061f), Vector3.one * 0.015f, new Color(0.04f, 0.13f, 0.17f));
            speaker = pip.AddComponent<AudioSource>();
            speaker.spatialBlend = 0;
            speaker.playOnAwake = false;
            panel = CreateText("Pip status", head, new Vector3(0, -0.18f, 0.85f), 0.017f, TextAnchor.UpperCenter);
            reticle = CreateText("Camera aiming reticle", null, Vector3.zero, 0.035f, TextAnchor.MiddleCenter).transform;
            reticle.GetComponent<TextMesh>().text = "+";
            UpdatePanel();
        }

        private static TextMesh CreateText(string name, Transform parent, Vector3 position, float size, TextAnchor anchor)
        {
            var go = new GameObject(name);
            go.transform.SetParent(parent, false);
            go.transform.localPosition = position;
            var text = go.AddComponent<TextMesh>();
            text.font = Resources.GetBuiltinResource<Font>("LegacyRuntime.ttf");
            text.GetComponent<Renderer>().sharedMaterial = text.font.material;
            text.fontSize = 48;
            text.characterSize = size;
            text.anchor = anchor;
            text.alignment = TextAlignment.Center;
            text.richText = false;
            text.color = Color.white;
            return text;
        }

        private static GameObject CreatePart(PrimitiveType primitive, Transform parent, Vector3 position, Vector3 scale, Color color)
        {
            var part = GameObject.CreatePrimitive(primitive);
            part.transform.SetParent(parent, false);
            part.transform.localPosition = position;
            part.transform.localScale = scale;
            var shader = Shader.Find("Unlit/Color");
            if (shader == null) throw new InvalidOperationException("The Unlit/Color shader must be included in the build.");
            var material = new Material(shader) { color = color };
            part.GetComponent<Renderer>().sharedMaterial = material;
            part.AddComponent<PipMaterialOwner>().Value = material;
            Destroy(part.GetComponent<Collider>());
            return part;
        }

        private void Update()
        {
            if (head == null) return;
            if (pip != null) pip.transform.rotation = Quaternion.LookRotation(pip.transform.position - head.position);
            if (CameraAccess != null && CameraAccess.IsPlaying && reticle != null)
            {
                var ray = CameraAccess.ViewportPointToRay(new Vector2(0.5f, 0.5f));
                reticle.position = EnvironmentRaycastManager.IsSupported && EnvironmentRaycaster.Raycast(ray, out var hit)
                    ? hit.point : ray.GetPoint(0.7f);
                reticle.rotation = head.rotation;
            }
            if (!initialized) return;
            if (InputManager.IsButtonADownOrPinchStarted())
                ToggleRecording();
            if (OVRInput.GetDown(OVRInput.Button.One, OVRInput.Controller.LTouch)) CancelTurn();
            if (recordingActive && Time.realtimeSinceStartup - recordingStarted >= 20) SendRecording();
            if (state == "Speaking" && !speaker.isPlaying)
                Show("Ready", "Press A or pinch to talk again. Press X to cancel a turn.");
        }

        private void ToggleRecording()
        {
            if (recordingActive) { SendRecording(); return; }
            if (busy || speaker.isPlaying) { CancelTurn(); return; }
#if UNITY_ANDROID && !UNITY_EDITOR
            if (!Permission.HasUserAuthorizedPermission(Permission.Microphone))
            {
                ShowError("Microphone permission is denied. Enable it in the Quest app settings and restart.");
                return;
            }
#endif
            try
            {
                recording = Microphone.Start(null, false, 20, 16000);
                if (recording == null) throw new InvalidOperationException("The headset microphone did not start.");
                recordingStarted = Time.realtimeSinceStartup;
                recordingActive = true;
                Show("Listening", "Press A or pinch again to send. Maximum 20 seconds. Press X to discard.");
            }
            catch (Exception error) { ShowError(error.Message); }
        }

        private void SendRecording()
        {
            recordingActive = false;
            var position = Microphone.GetPosition(null);
            var elapsed = Time.realtimeSinceStartup - recordingStarted;
            Microphone.End(null);
            try
            {
                if (elapsed < 0.35f) throw new InvalidOperationException("Recording was too short. Try a complete sentence.");
                if (position == 0 && elapsed >= 19.9f) position = recording.samples;
                var audio = PipAudio.EncodeWav(recording, position);
                var image = CaptureSnapshot();
                var body = new VoiceRequest
                {
                    audio = Convert.ToBase64String(audio), image = Convert.ToBase64String(image),
                    history = history.ToArray(),
                    context = new ObjectContext { hasObject = proxy != null, label = objectContext.label, shape = objectContext.shape }
                };
                busy = true;
                Show("Thinking", "Processing speech and this camera snapshot locally on your Mac...");
                conversation = StartCoroutine(RequestReply(JsonUtility.ToJson(body)));
            }
            catch (Exception error) { ShowError(error.Message); }
            finally
            {
                if (recording != null) Destroy(recording);
                recording = null;
            }
        }

        private byte[] CaptureSnapshot()
        {
            if (!CameraAccess.IsPlaying) throw new InvalidOperationException("The headset camera is not available.");
            var texture = CameraAccess.GetTexture();
            if (texture == null) throw new InvalidOperationException("No camera image is available yet. Try again.");
            var ray = CameraAccess.ViewportPointToRay(new Vector2(0.5f, 0.5f));
            snapshotHasDepth = EnvironmentRaycaster.Raycast(ray, out var hit);
            if (snapshotHasDepth)
            {
                var distance = Vector3.Distance(ray.origin, hit.point);
                snapshotHasDepth = distance >= 0.15f && distance <= 3f;
            }
            if (snapshotHasDepth) snapshotPoint = hit.point;
            var height = Mathf.RoundToInt(640f * texture.height / texture.width);
            var target = RenderTexture.GetTemporary(640, height, 0, RenderTextureFormat.ARGB32);
            var previous = RenderTexture.active;
            var readable = new Texture2D(640, height, TextureFormat.RGB24, false);
            try
            {
                Graphics.Blit(texture, target);
                RenderTexture.active = target;
                readable.ReadPixels(new Rect(0, 0, 640, height), 0, 0);
                readable.Apply();
                return readable.EncodeToJPG(75);
            }
            finally
            {
                RenderTexture.active = previous;
                RenderTexture.ReleaseTemporary(target);
                Destroy(readable);
            }
        }

        private IEnumerator RequestReply(string json)
        {
            using var request = new UnityWebRequest($"{ServerUrl.TrimEnd('/')}/api/companion/native", "POST");
            activeRequest = request;
            request.uploadHandler = new UploadHandlerRaw(Encoding.UTF8.GetBytes(json));
            request.downloadHandler = new DownloadHandlerBuffer();
            request.certificateHandler = new PinnedCertificateHandler(ServerCertificateSha256);
            request.SetRequestHeader("Content-Type", "application/json");
            request.timeout = 180;
            yield return request.SendWebRequest();
            activeRequest = null;
            busy = false;
            conversation = null;
            try
            {
                if (request.result != UnityWebRequest.Result.Success)
                {
                    var failure = string.IsNullOrEmpty(request.downloadHandler.text) ? null : JsonUtility.FromJson<Reply>(request.downloadHandler.text);
                    throw new InvalidOperationException(failure?.error ?? $"Cannot reach the Mac companion: {request.error}. Check Wi-Fi, server, and certificate fingerprint.");
                }
                var response = JsonUtility.FromJson<Reply>(request.downloadHandler.text);
                if (response == null || string.IsNullOrWhiteSpace(response.text) || string.IsNullOrEmpty(response.audio))
                    throw new InvalidOperationException("The local AI returned an incomplete reply.");
                ExecuteAction(response);
                lastTranscript = response.transcript;
                lastReply = response.text;
                history.Add(new Message { role = "user", content = lastTranscript });
                history.Add(new Message { role = "assistant", content = lastReply });
                while (history.Count > 8) history.RemoveRange(0, 2);
                if (speaker.clip != null) Destroy(speaker.clip);
                speaker.clip = PipAudio.DecodeWav(Convert.FromBase64String(response.audio));
                speaker.Play();
                Show("Speaking", "Press A, pinch, or press X to stop the reply.");
            }
            catch (Exception error) { ShowError(error.Message); }
        }

        private void ExecuteAction(Reply response)
        {
            if (response.action == "none") return;
            if (response.action != "pick_up_object" && response.action != "throw_object" && response.action != "put_down_object")
                throw new InvalidOperationException("The companion requested an unsupported action.");
            if (actionRoutine != null) throw new InvalidOperationException("Wait for Pip to finish the current movement.");
            var target = response.target;
            if (target == null || string.IsNullOrWhiteSpace(target.label)) throw new InvalidOperationException("No object was identified.");
            var existing = target.useExisting && proxy != null && string.Equals(target.label, objectContext.label, StringComparison.OrdinalIgnoreCase);
            if (target.useExisting && !existing) throw new InvalidOperationException("That virtual object is no longer available. Center the real object and ask again.");
            if (!existing)
            {
                if (target.xMin > 500 || target.xMax < 500 || target.yMin > 500 || target.yMax < 500)
                    throw new InvalidOperationException("Center the requested object on the + and try again.");
                if (!snapshotHasDepth) throw new InvalidOperationException("No reliable depth at the aiming point. Look at a closer, well-lit object and try again.");
                if (response.action == "put_down_object") throw new InvalidOperationException("Pip does not have a virtual copy of that object.");
                if (proxy != null) Destroy(proxy);
                proxy = CreateProxy(target.shape);
                proxy.name = $"Virtual {target.label}";
                proxy.transform.position = snapshotPoint + Vector3.up * 0.04f;
                proxyHome = proxy.transform.position;
                objectContext.label = target.label;
                objectContext.shape = target.shape;
            }
            actionRoutine = StartCoroutine(AnimateAction(response.action));
        }

        private GameObject CreateProxy(string shape)
        {
            var root = new GameObject("Virtual object proxy");
            switch (shape)
            {
                case "pen":
                    CreatePart(PrimitiveType.Cylinder, root.transform, Vector3.zero, new Vector3(0.012f, 0.075f, 0.012f), Color.cyan);
                    root.transform.rotation = Quaternion.Euler(0, 0, 90);
                    break;
                case "cup":
                    CreatePart(PrimitiveType.Cylinder, root.transform, Vector3.zero, new Vector3(0.075f, 0.06f, 0.075f), new Color(0.6f, 0.9f, 1));
                    break;
                case "bottle":
                    CreatePart(PrimitiveType.Cylinder, root.transform, Vector3.zero, new Vector3(0.065f, 0.1f, 0.065f), new Color(0.4f, 0.8f, 0.7f));
                    CreatePart(PrimitiveType.Cylinder, root.transform, new Vector3(0, 0.12f, 0), new Vector3(0.025f, 0.03f, 0.025f), Color.white);
                    break;
                case "book":
                    CreatePart(PrimitiveType.Cube, root.transform, Vector3.zero, new Vector3(0.14f, 0.025f, 0.2f), new Color(0.8f, 0.5f, 0.95f));
                    break;
                case "box":
                    CreatePart(PrimitiveType.Cube, root.transform, Vector3.zero, Vector3.one * 0.12f, new Color(0.9f, 0.7f, 0.4f));
                    break;
                case "generic":
                    CreatePart(PrimitiveType.Sphere, root.transform, Vector3.zero, Vector3.one * 0.1f, IdleColor);
                    break;
                default:
                    Destroy(root);
                    throw new InvalidOperationException("The AI requested an unsupported proxy shape.");
            }
            return root;
        }

        private IEnumerator AnimateAction(string action)
        {
            if (action == "put_down_object")
            {
                proxy.transform.SetParent(null, true);
                yield return MoveTo(proxy.transform, proxyHome, 0.6f);
            }
            else
            {
                yield return MoveTo(pip.transform, proxy.transform.position + new Vector3(-0.1f, 0.2f, 0), 0.6f);
                proxy.transform.SetParent(pip.transform, true);
                proxy.transform.localPosition = new Vector3(0.1f, -0.1f, 0);
                if (action == "throw_object")
                {
                    yield return new WaitForSeconds(0.3f);
                    proxy.transform.SetParent(null, true);
                    var start = proxy.transform.position;
                    var away = Vector3.ProjectOnPlane(start - head.position, Vector3.up).normalized;
                    if (away.sqrMagnitude < 0.01f) away = Vector3.ProjectOnPlane(head.forward, Vector3.up).normalized;
                    var velocity = away * 1.7f + Vector3.up * 1.6f;
                    for (var elapsed = 0f; elapsed < 1.2f; elapsed += Time.deltaTime)
                    {
                        proxy.transform.position = start + velocity * elapsed + Vector3.down * (4.9f * elapsed * elapsed);
                        proxy.transform.Rotate(110 * Time.deltaTime, 75 * Time.deltaTime, 0);
                        proxy.transform.localScale = Vector3.one * Mathf.Clamp01((1.2f - elapsed) * 5);
                        yield return null;
                    }
                    Destroy(proxy);
                    proxy = null;
                    objectContext.label = "";
                    objectContext.shape = "generic";
                }
            }
            actionRoutine = null;
        }

        private static IEnumerator MoveTo(Transform item, Vector3 destination, float seconds)
        {
            var start = item.position;
            for (var elapsed = 0f; elapsed < seconds; elapsed += Time.deltaTime)
            {
                item.position = Vector3.Lerp(start, destination, Mathf.SmoothStep(0, 1, elapsed / seconds));
                yield return null;
            }
            item.position = destination;
        }

        private void CancelTurn()
        {
            if (recordingActive) Microphone.End(null);
            recordingActive = false;
            if (recording != null) Destroy(recording);
            recording = null;
            activeRequest?.Abort();
            if (conversation != null) StopCoroutine(conversation);
            activeRequest?.Dispose();
            conversation = null;
            activeRequest = null;
            busy = false;
            if (speaker != null) speaker.Stop();
            if (initialized) Show("Ready", "Turn cancelled. Microphone is off.");
        }

        private void Show(string nextState, string message)
        {
            state = nextState;
            detail = message;
            if (pipRenderer != null)
                pipRenderer.sharedMaterial.color = state == "Listening" ? new Color(1, 0.7f, 0.3f)
                    : state == "Thinking" ? new Color(0.7f, 0.6f, 1)
                    : state == "Error" ? new Color(1, 0.5f, 0.45f) : IdleColor;
            UpdatePanel();
        }

        private void ShowError(string message)
        {
            Debug.LogError($"Pip: {message}");
            busy = false;
            Show("Error", message);
        }

        private void UpdatePanel()
        {
            if (panel == null) return;
            panel.text = $"PIP / {state.ToUpperInvariant()} / LOCAL AI\n\n{Wrap(detail, 64)}\n\n{Wrap(lastReply, 64)}"
                + (string.IsNullOrEmpty(lastTranscript) ? "" : $"\n\nYou: {Wrap(lastTranscript, 64)}");
        }

        private static string Wrap(string text, int width)
        {
            var output = new StringBuilder();
            var column = 0;
            foreach (var word in text.Split(' '))
            {
                if (column + word.Length > width) { output.Append('\n'); column = 0; }
                if (column > 0) { output.Append(' '); column++; }
                output.Append(word);
                column += word.Length;
            }
            return output.ToString();
        }

        private void OnApplicationPause(bool paused) { if (paused) CancelTurn(); }
        private void OnDisable() { CancelTurn(); }

        private sealed class PinnedCertificateHandler : CertificateHandler
        {
            private readonly string expected;
            public PinnedCertificateHandler(string fingerprint) { expected = fingerprint; }
            protected override bool ValidateCertificate(byte[] certificateData)
            {
                using var sha = SHA256.Create();
                var actual = BitConverter.ToString(sha.ComputeHash(certificateData)).Replace("-", "");
                return string.Equals(actual, expected, StringComparison.OrdinalIgnoreCase);
            }
        }
    }
}
