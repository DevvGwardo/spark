import { useState, useRef, useCallback, useEffect } from 'react';
import { getApiBaseUrl } from '@/lib/api';
import type { Provider } from '@/stores/settings-store';

type TranscribeProvider = 'groq' | 'openai';

export interface VoiceInputState {
  isRecording: boolean;
  isTranscribing: boolean;
  error: string | null;
}

export interface UseVoiceInputResult extends VoiceInputState {
  startRecording: () => Promise<void>;
  stopRecording: () => Promise<string | null>;
  cancelRecording: () => void;
}

/**
 * Resolves which provider to use for transcription and its API key.
 * Priority: Groq (if key available) → OpenAI (if key available).
 * Returns null if no suitable provider is found.
 */
function resolveTranscriptionConfig(
  providers: Record<Provider, { apiKey: string }>,
): { provider: TranscribeProvider; apiKey: string } | null {
  if (providers.groq?.apiKey?.trim()) {
    return { provider: 'groq', apiKey: providers.groq.apiKey.trim() };
  }
  if (providers.openai?.apiKey?.trim()) {
    return { provider: 'openai', apiKey: providers.openai.apiKey.trim() };
  }
  return null;
}

async function transcribeAudio(
  audioBlob: Blob,
  provider: TranscribeProvider,
  apiKey: string,
): Promise<string> {
  // Convert blob to base64
  const arrayBuffer = await audioBlob.arrayBuffer();
  const uint8 = new Uint8Array(arrayBuffer);
  let binary = '';
  for (let i = 0; i < uint8.length; i++) {
    binary += String.fromCharCode(uint8[i]);
  }
  const base64Audio = btoa(binary);

  const mimeType = audioBlob.type || 'audio/webm';
  // Extract extension from mime type (e.g. audio/webm → webm, audio/mp4 → mp4)
  const ext = mimeType.split('/')[1] || 'webm';
  const filename = `recording.${ext}`;

  const response = await fetch(`${getApiBaseUrl()}/functions/v1/transcribe`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      provider,
      api_key: apiKey,
      audio: base64Audio,
      filename,
    }),
  });

  if (!response.ok) {
    let errorMsg = `Transcription failed (${response.status})`;
    try {
      const data = await response.json();
      if (data?.error) errorMsg = data.error;
    } catch {
      // Non-JSON error
    }
    throw new Error(errorMsg);
  }

  const data = await response.json();
  return data.text ?? '';
}

export function useVoiceInput(
  providers: Record<Provider, { apiKey: string }>,
): UseVoiceInputResult {
  const [isRecording, setIsRecording] = useState(false);
  const [isTranscribing, setIsTranscribing] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const chunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);

  // Keep a ref to providers so callbacks don't recreate on every provider change
  const providersRef = useRef(providers);
  providersRef.current = providers;

  // ── Stream cleanup (defined first so startRecording can reference it) ──────
  const cleanupStream = useCallback(() => {
    if (streamRef.current) {
      streamRef.current.getTracks().forEach((track) => track.stop());
      streamRef.current = null;
    }
    mediaRecorderRef.current = null;
    chunksRef.current = [];
  }, []);

  // Cleanup on unmount — stop any active recording/stream so the OS mic indicator goes away
  useEffect(() => {
    return () => {
      if (streamRef.current) {
        streamRef.current.getTracks().forEach((track) => track.stop());
        streamRef.current = null;
      }
      if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
        mediaRecorderRef.current.onstop = null; // prevent transcription attempt after unmount
        mediaRecorderRef.current.stop();
      }
      mediaRecorderRef.current = null;
      chunksRef.current = [];
    };
  }, []);

  // ── Start recording ───────────────────────────────────────────────────────
  const startRecording = useCallback(async () => {
    setError(null);
    chunksRef.current = [];

    const config = resolveTranscriptionConfig(providersRef.current);
    if (!config) {
      setError('No transcription provider available. Add a Groq or OpenAI API key in settings.');
      return;
    }

    try {
      const stream = await navigator.mediaDevices.getUserMedia({
        audio: {
          channelCount: 1,
          sampleRate: 16000,
          echoCancellation: true,
          noiseSuppression: true,
        },
      });
      streamRef.current = stream;

      // Determine supported MIME type
      const mimeType = MediaRecorder.isTypeSupported('audio/webm;codecs=opus')
        ? 'audio/webm;codecs=opus'
        : MediaRecorder.isTypeSupported('audio/webm')
          ? 'audio/webm'
          : MediaRecorder.isTypeSupported('audio/mp4')
            ? 'audio/mp4'
            : '';

      const recorder = new MediaRecorder(stream, {
        mimeType: mimeType || undefined,
      });

      recorder.ondataavailable = (e) => {
        if (e.data.size > 0) {
          chunksRef.current.push(e.data);
        }
      };

      recorder.onerror = () => {
        setError('Microphone recording error.');
        cleanupStream();
        setIsRecording(false);
      };

      mediaRecorderRef.current = recorder;
      recorder.start(1000); // Collect chunks every second
      setIsRecording(true);
    } catch (err: any) {
      if (err.name === 'NotAllowedError' || err.name === 'PermissionDeniedError') {
        setError('Microphone permission denied. Allow microphone access in your system settings.');
      } else if (err.name === 'NotFoundError') {
        setError('No microphone found. Connect a microphone and try again.');
      } else {
        setError(err.message || 'Failed to start recording.');
      }
    }
  }, [cleanupStream]);

  // ── Stop recording and transcribe ────────────────────────────────────────
  const stopRecording = useCallback(async (): Promise<string | null> => {
    const recorder = mediaRecorderRef.current;
    if (!recorder || recorder.state === 'inactive') {
      cleanupStream();
      setIsRecording(false);
      return null;
    }

    const config = resolveTranscriptionConfig(providersRef.current);
    if (!config) {
      cleanupStream();
      setIsRecording(false);
      setError('No transcription provider available.');
      return null;
    }

    // Return a promise that resolves when the recorder stops and data is collected
    return new Promise<string | null>((resolve) => {
      recorder.onstop = async () => {
        cleanupStream();
        setIsRecording(false);

        if (chunksRef.current.length === 0) {
          setError('No audio recorded.');
          resolve(null);
          return;
        }

        const mimeType = recorder.mimeType || 'audio/webm';
        const blob = new Blob(chunksRef.current, { type: mimeType });
        chunksRef.current = [];

        setIsTranscribing(true);
        setError(null);

        try {
          const text = await transcribeAudio(blob, config.provider, config.apiKey);
          if (!text.trim()) {
            setError('No speech detected. Try again.');
            resolve(null);
          } else {
            resolve(text.trim());
          }
        } catch (err: any) {
          setError(err.message || 'Transcription failed.');
          resolve(null);
        } finally {
          setIsTranscribing(false);
        }
      };

      recorder.stop();
    });
  }, [cleanupStream]);

  // ── Cancel recording (no transcription) ──────────────────────────────────
  const cancelRecording = useCallback(() => {
    const recorder = mediaRecorderRef.current;
    if (recorder && recorder.state !== 'inactive') {
      // Remove onstop handler so it doesn't try to transcribe
      recorder.onstop = null;
      recorder.stop();
    }
    cleanupStream();
    setIsRecording(false);
    setIsTranscribing(false);
    setError(null);
  }, [cleanupStream]);

  return {
    isRecording,
    isTranscribing,
    error,
    startRecording,
    stopRecording,
    cancelRecording,
  };
}
