/** Storyboard (d): phone pairing — a mini phone outline with a pulsing QR placeholder.
 *  No screenshots/video: the "QR" is a CSS grid of squares. */
export default function PhonePairingFrame() {
  const cells = Array.from({ length: 25 }, (_, i) => i)
  return (
    <div className="flex h-full w-full items-center justify-center gap-4 rounded-lg border border-border bg-bg p-3">
      <div className="onb-qr-pulse grid grid-cols-5 gap-[2px] rounded bg-card p-1.5">
        {cells.map((i) => (
          <span
            key={i}
            className={`h-1.5 w-1.5 rounded-[1px] ${(i * 7) % 3 === 0 ? 'bg-text/70' : 'bg-text/15'}`}
          />
        ))}
      </div>
      <div className="flex h-16 w-9 flex-col items-center gap-1 rounded-[6px] border-2 border-text/30 p-1">
        <span className="h-0.5 w-3 rounded-full bg-text/30" />
        <div className="flex flex-1 items-center justify-center">
          <span className="h-1.5 w-1.5 rounded-full bg-ok" />
        </div>
      </div>
    </div>
  )
}
