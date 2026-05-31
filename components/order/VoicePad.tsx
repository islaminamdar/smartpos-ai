'use client'
import { useRef, useState } from 'react'
import { Button } from '@/components/ui/button'
import { Mic, Square } from 'lucide-react'

export function VoicePad({
  locale,
  onResult,
}: {
  locale: string
  onResult: (orderId: string, parsed: any) => void
}) {
  const [recording, setRecording] = useState(false)
  const [busy, setBusy] = useState(false)
  const recorderRef = useRef<MediaRecorder | null>(null)
  const chunksRef = useRef<Blob[]>([])

  async function start() {
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const rec = new MediaRecorder(stream, { mimeType: 'audio/webm' })
    chunksRef.current = []
    rec.ondataavailable = (e) => e.data.size && chunksRef.current.push(e.data)
    rec.onstop = async () => {
      const blob = new Blob(chunksRef.current, { type: 'audio/webm' })
      stream.getTracks().forEach((t) => t.stop())
      await submit(blob)
    }
    recorderRef.current = rec
    rec.start()
    setRecording(true)
  }

  function stop() {
    recorderRef.current?.stop()
    setRecording(false)
  }

  async function submit(blob: Blob) {
    setBusy(true)
    try {
      const buf = await blob.arrayBuffer()
      const bytes = new Uint8Array(buf)
      let binary = ''
      for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i])
      const audioBase64 = btoa(binary)
      const res = await fetch('/api/ai/parse-order', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ kind: 'audio', audioBase64, mime: blob.type, locale }),
      })
      const json = await res.json()
      onResult(json.orderId, json.parsed)
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="flex flex-col items-center gap-4">
      <Button
        size="lg"
        className="h-32 w-32 rounded-full"
        onClick={recording ? stop : start}
        disabled={busy}
        aria-label={recording ? 'Stop recording' : 'Start recording'}
      >
        {recording ? <Square className="h-12 w-12" /> : <Mic className="h-12 w-12" />}
      </Button>
      <p className="text-sm text-muted-foreground">
        {busy ? 'Transcribing…' : recording ? 'Listening… tap to stop' : 'Tap and speak the order'}
      </p>
    </div>
  )
}
