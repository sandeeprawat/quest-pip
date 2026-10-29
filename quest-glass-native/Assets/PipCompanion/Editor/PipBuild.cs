using System;
using System.IO;
using System.Linq;
using System.Security.Cryptography;
using Meta.XR;
using PassthroughCameraSamples.CameraViewer;
using PassthroughCameraSamples.StartScene;
using UnityEditor;
using UnityEditor.Build;
using UnityEditor.Build.Reporting;
using UnityEditor.SceneManagement;
using UnityEngine;
using UnityEngine.Rendering;

namespace PipCompanion.Editor
{
    public static class PipBuild
    {
        private const string ScenePath = "Assets/PipCompanion/PipCompanion.unity";

        [MenuItem("Pip/Create Companion Scene")]
        public static void CreateScene()
        {
            var scene = EditorSceneManager.OpenScene("Assets/PassthroughCameraApiSamples/CameraViewer/CameraViewer.unity");
            foreach (var viewer in UnityEngine.Object.FindObjectsByType<CameraViewerManager>(FindObjectsSortMode.None))
                UnityEngine.Object.DestroyImmediate(viewer.gameObject);
            foreach (var canvas in UnityEngine.Object.FindObjectsByType<Canvas>(FindObjectsSortMode.None))
                UnityEngine.Object.DestroyImmediate(canvas.gameObject);
            foreach (var returnMenu in UnityEngine.Object.FindObjectsByType<ReturnToStartScene>(FindObjectsSortMode.None))
            {
                var menuSettings = new SerializedObject(returnMenu);
                var tooltip = menuSettings.FindProperty("_tooltipText").objectReferenceValue as TextMesh;
                if (tooltip != null) UnityEngine.Object.DestroyImmediate(tooltip.gameObject);
                UnityEngine.Object.DestroyImmediate(returnMenu);
            }
            var runtime = new GameObject("Pip Companion").AddComponent<PipCompanionRuntime>();
            new GameObject("Pip Passthrough").AddComponent<OVRPassthroughLayer>();
            runtime.CameraAccess = UnityEngine.Object.FindFirstObjectByType<PassthroughCameraAccess>();
            if (runtime.CameraAccess == null) throw new BuildFailedException("The Meta camera sample did not contain PassthroughCameraAccess.");
            var depthPrefab = AssetDatabase.LoadAssetAtPath<GameObject>(
                "Assets/PassthroughCameraApiSamples/MultiObjectDetection/EnvironmentRaycast/Prefabs/EnvironmentRaycastPrefab.prefab");
            if (depthPrefab == null) throw new BuildFailedException("The Meta environment raycast prefab is missing.");
            var depth = (GameObject)PrefabUtility.InstantiatePrefab(depthPrefab);
            runtime.EnvironmentRaycaster = depth.GetComponent<EnvironmentRaycastManager>();
            if (runtime.EnvironmentRaycaster == null) throw new BuildFailedException("The Meta depth prefab did not contain EnvironmentRaycastManager.");
            var certificatePath = Path.GetFullPath(Path.Combine(Application.dataPath, "../../quest-glass/node_modules/.vite/basic-ssl/_cert.pem"));
            if (!File.Exists(certificatePath)) throw new BuildFailedException("Start the Mac HTTPS companion server first to generate its certificate.");
            var pem = File.ReadAllText(certificatePath);
            const string begin = "-----BEGIN CERTIFICATE-----";
            var beginIndex = pem.IndexOf(begin, StringComparison.Ordinal);
            var endIndex = pem.IndexOf("-----END CERTIFICATE-----", StringComparison.Ordinal);
            if (beginIndex < 0 || endIndex <= beginIndex) throw new BuildFailedException("The local HTTPS certificate is invalid.");
            var certificateBytes = Convert.FromBase64String(pem.Substring(beginIndex + begin.Length, endIndex - beginIndex - begin.Length));
            using var sha = SHA256.Create();
            runtime.ServerCertificateSha256 = BitConverter.ToString(sha.ComputeHash(certificateBytes)).Replace("-", "");
            var url = Environment.GetEnvironmentVariable("PIP_SERVER_URL");
            if (!string.IsNullOrEmpty(url)) runtime.ServerUrl = url;
            var unlit = Shader.Find("Unlit/Color");
            if (unlit == null) throw new BuildFailedException("Unlit/Color shader is unavailable.");
            var graphics = new SerializedObject(AssetDatabase.LoadAllAssetsAtPath("ProjectSettings/GraphicsSettings.asset")[0]);
            var shaders = graphics.FindProperty("m_AlwaysIncludedShaders");
            if (!Enumerable.Range(0, shaders.arraySize).Any(index => shaders.GetArrayElementAtIndex(index).objectReferenceValue == unlit))
            {
                shaders.InsertArrayElementAtIndex(shaders.arraySize);
                shaders.GetArrayElementAtIndex(shaders.arraySize - 1).objectReferenceValue = unlit;
                graphics.ApplyModifiedPropertiesWithoutUndo();
            }
            if (!EditorSceneManager.SaveScene(scene, ScenePath))
                throw new BuildFailedException("Could not save the Pip companion scene.");
            EditorBuildSettings.scenes = new[] { new EditorBuildSettingsScene(ScenePath, true) };
            PlayerSettings.companyName = "Glass Lab";
            PlayerSettings.productName = "Pip Mixed Reality";
            PlayerSettings.SetApplicationIdentifier(NamedBuildTarget.Android, "com.glasslab.pip");
            PlayerSettings.Android.minSdkVersion = AndroidSdkVersions.AndroidApiLevel32;
            PlayerSettings.SetScriptingBackend(NamedBuildTarget.Android, ScriptingImplementation.IL2CPP);
            PlayerSettings.Android.targetArchitectures = AndroidArchitecture.ARM64;
            PlayerSettings.SetGraphicsAPIs(BuildTarget.Android, new[] { GraphicsDeviceType.Vulkan });
            AssetDatabase.SaveAssets();
            Debug.Log("Pip companion scene created. Confirm the Mac URL and certificate fingerprint on Pip Companion.");
        }

        [MenuItem("Pip/Build Quest APK")]
        public static void Build()
        {
            if (!File.Exists(ScenePath)) CreateScene();
            Directory.CreateDirectory("Builds");
            var report = BuildPipeline.BuildPlayer(new BuildPlayerOptions
            {
                scenes = new[] { ScenePath },
                locationPathName = "Builds/PipCompanion.apk",
                target = BuildTarget.Android,
                options = BuildOptions.Development,
            });
            if (report.summary.result != BuildResult.Succeeded)
                throw new BuildFailedException($"Quest build failed: {report.summary.result}");
            Debug.Log($"Quest APK ready: {Path.GetFullPath("Builds/PipCompanion.apk")}");
        }
    }
}
