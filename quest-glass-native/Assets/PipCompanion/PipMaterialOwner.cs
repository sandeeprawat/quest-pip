using UnityEngine;

namespace PipCompanion
{
    public sealed class PipMaterialOwner : MonoBehaviour
    {
        public Material Value;

        private void OnDestroy()
        {
            if (Value != null) Destroy(Value);
        }
    }
}
