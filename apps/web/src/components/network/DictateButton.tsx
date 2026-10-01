/*
 * Copyright 2026 Incident Command Agent contributors
 * SPDX-License-Identifier: Apache-2.0
 */
/**
 * Voice input for the free-text incident description, using the browser's own speech recognition (Web Speech API,
 * Chrome/Edge). Renders nothing where the API is unavailable. Final phrases are appended to the text; the person can
 * still edit everything by hand. No audio or text touches our backend until the normal "Start".
 */
import { useEffect, useRef, useState } from 'react';
import { cx } from '../ui/primitives';

interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
interface RecognitionEvent {
  resultIndex: number;
  results: ArrayLike<RecognitionResult>;
}
interface Recognition {
  lang: string;
  continuous: boolean;
  interimResults: boolean;
  onresult: ((e: RecognitionEvent) => void) | null;
  onend: (() => void) | null;
  onerror: ((e: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}
type RecognitionCtor = new () => Recognition;

function recognitionCtor(): RecognitionCtor | null {
  if (typeof window === 'undefined') return null;
  const w = window as unknown as {
    SpeechRecognition?: RecognitionCtor;
    webkitSpeechRecognition?: RecognitionCtor;
  };
  return w.SpeechRecognition ?? w.webkitSpeechRecognition ?? null;
}

export function DictateButton({ onText }: { onText: (phrase: string) => void }) {
  const Ctor = recognitionCtor();
  const rec = useRef<Recognition | null>(null);
  const [listening, setListening] = useState(false);
  const [interim, setInterim] = useState('');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => () => rec.current?.stop(), []);
  if (!Ctor) return null;

  const start = () => {
    setError(null);
    try {
      const r = new Ctor();
      r.lang = 'en-GB';
      r.continuous = true;
      r.interimResults = true;
      r.onresult = (e) => {
        let live = '';
        for (let i = e.resultIndex; i < e.results.length; i++) {
          const res = e.results[i];
          const t = res[0].transcript.trim();
          if (!t) continue;
          if (res.isFinal) onText(t);
          else live += `${t} `;
        }
        setInterim(live.trim());
      };
      r.onerror = (e) =>
        setError(
          e.error === 'not-allowed' || e.error === 'service-not-allowed'
            ? 'Microphone access was blocked — allow it in the browser to dictate.'
            : e.error === 'no-speech'
              ? null
              : 'Dictation stopped — you can type instead.',
        );
      r.onend = () => {
        setListening(false);
        setInterim('');
      };
      rec.current = r;
      r.start();
      setListening(true);
    } catch {
      setListening(false);
      setError('Dictation is not available here — you can type instead.');
    }
  };
  const stop = () => rec.current?.stop();

  return (
    <div className="flex flex-col gap-1">
      <button
        type="button"
        onClick={listening ? stop : start}
        aria-pressed={listening}
        data-testid="dictate"
        className={cx(
          'inline-flex w-fit items-center gap-2 rounded-md border px-3 py-1.5 text-caption font-semibold',
          listening
            ? 'border-critical/60 bg-critical-bg text-fg'
            : 'border-border-control/70 bg-surface text-fg hover:bg-surface-hover',
        )}
      >
        <span
          aria-hidden="true"
          className={cx(
            'inline-block h-2 w-2 rounded-full',
            listening ? 'animate-pulse bg-critical' : 'bg-fg-muted',
          )}
        />
        {listening ? 'Stop dictation' : 'Dictate'}
      </button>
      <span className="text-caption text-fg-muted" aria-live="polite">
        {error ?? (listening ? interim || 'Listening… speak your description.' : '')}
      </span>
    </div>
  );
}
