import { CHANNEL_META, type Channel } from "../lib/sample-data"

type Props = {
  channels: Channel[]
}

// Legend strip lives in the FOOTER, not the header. The header band is
// reserved for "what week am I looking at"; the legend is reference info
// that you only glance at occasionally. Keeping it out of the prime
// chrome avoids drowning the page in metadata bars.
export function ChannelLegend({ channels }: Props) {
  return (
    <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-t border-border px-10 py-4 text-[10px] text-fg-48">
      <span className="tracking-[0.08em] uppercase text-fg-32">Channels</span>
      {channels.map((channel) => {
        const meta = CHANNEL_META[channel]
        return (
          <span key={channel} className="inline-flex items-center gap-1.5">
            <span className={["size-2 rounded-sm", meta.tint].join(" ")} aria-hidden />
            <span className="text-fg-64">{meta.label}</span>
          </span>
        )
      })}
    </div>
  )
}
