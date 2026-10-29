using System;
using System.IO;
using System.Text;
using UnityEngine;

namespace PipCompanion
{
    public static class PipAudio
    {
        public static byte[] EncodeWav(AudioClip clip, int frames)
        {
            if (clip == null || frames <= 0 || frames > clip.samples)
                throw new ArgumentException("The microphone recording is empty or invalid.");
            var samples = new float[frames * clip.channels];
            if (!clip.GetData(samples, 0)) throw new InvalidOperationException("Could not read the microphone recording.");
            using var stream = new MemoryStream();
            using var writer = new BinaryWriter(stream, Encoding.ASCII);
            writer.Write(Encoding.ASCII.GetBytes("RIFF"));
            writer.Write(36 + samples.Length * 2);
            writer.Write(Encoding.ASCII.GetBytes("WAVEfmt "));
            writer.Write(16);
            writer.Write((short)1);
            writer.Write((short)clip.channels);
            writer.Write(clip.frequency);
            writer.Write(clip.frequency * clip.channels * 2);
            writer.Write((short)(clip.channels * 2));
            writer.Write((short)16);
            writer.Write(Encoding.ASCII.GetBytes("data"));
            writer.Write(samples.Length * 2);
            foreach (var sample in samples) writer.Write((short)(Mathf.Clamp(sample, -1, 1) * short.MaxValue));
            return stream.ToArray();
        }

        public static AudioClip DecodeWav(byte[] bytes)
        {
            using var stream = new MemoryStream(bytes);
            using var reader = new BinaryReader(stream, Encoding.ASCII);
            if (bytes.Length < 44 || new string(reader.ReadChars(4)) != "RIFF")
                throw new InvalidDataException("The voice reply is not a WAV file.");
            reader.ReadInt32();
            if (new string(reader.ReadChars(4)) != "WAVE") throw new InvalidDataException("Invalid WAV header.");
            int channels = 0, rate = 0;
            while (stream.Position + 8 <= stream.Length)
            {
                var name = new string(reader.ReadChars(4));
                var size = reader.ReadInt32();
                if (size < 0 || size > stream.Length - stream.Position) throw new InvalidDataException("Invalid WAV chunk size.");
                var end = stream.Position + size;
                if (name == "fmt ")
                {
                    if (size < 16 || reader.ReadInt16() != 1) throw new InvalidDataException("Expected PCM voice audio.");
                    channels = reader.ReadInt16();
                    rate = reader.ReadInt32();
                    reader.ReadInt32();
                    reader.ReadInt16();
                    if (reader.ReadInt16() != 16 || channels < 1 || channels > 2 || rate < 8000 || rate > 96000)
                        throw new InvalidDataException("Unsupported voice audio format.");
                }
                else if (name == "data")
                {
                    if (channels == 0 || size == 0 || size % (2 * channels) != 0)
                        throw new InvalidDataException("Invalid voice sample data.");
                    var samples = new float[size / 2];
                    for (var index = 0; index < samples.Length; index++) samples[index] = reader.ReadInt16() / 32768f;
                    var clip = AudioClip.Create("Pip reply", samples.Length / channels, channels, rate, false);
                    if (!clip.SetData(samples, 0)) throw new InvalidDataException("Could not decode the voice reply.");
                    return clip;
                }
                stream.Position = end + (size % 2);
            }
            throw new InvalidDataException("The voice reply has no audio data.");
        }
    }
}
