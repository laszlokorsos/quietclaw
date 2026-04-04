import { useState } from 'react'

interface Segment {
  speaker: string
  start: number
  end: number
  text: string
  source: string
}

interface SpeakerMappingProps {
  speakers: Array<{ name: string; source: string }>
  segments: Segment[]
  attendees: Array<{ name: string; email: string }>
  onSave: (mapping: Record<string, string>) => Promise<void>
}

/** Pick the most distinctive quotes for a speaker (longest, skip filler) */
function getRepresentativeQuotes(segments: Segment[], speakerName: string, max = 3): string[] {
  return segments
    .filter((s) => s.speaker === speakerName && s.text.length >= 20)
    .sort((a, b) => b.text.length - a.text.length)
    .slice(0, max)
    .map((s) => s.text.length > 120 ? s.text.slice(0, 117) + '...' : s.text)
}

export default function SpeakerMapping({ speakers, segments, attendees, onSave }: SpeakerMappingProps) {
  const [expanded, setExpanded] = useState(false)
  const [mapping, setMapping] = useState<Record<string, string>>({})
  const [customInputs, setCustomInputs] = useState<Record<string, boolean>>({})
  const [saving, setSaving] = useState(false)

  const unmapped = speakers.filter(
    (s) => s.source === 'system' && /^Speaker [A-Z]$/.test(s.name)
  )

  if (unmapped.length === 0) return null

  // Names already assigned in the current mapping session
  const assignedNames = new Set(Object.values(mapping).filter(Boolean))

  // Names that are already identified (mic speaker + any non-anonymous speakers)
  const alreadyNamed = new Set(
    speakers.filter((s) => !/^Speaker [A-Z]$/.test(s.name)).map((s) => s.name)
  )

  const hasChanges = Object.values(mapping).some(Boolean)

  async function handleSave() {
    if (!hasChanges || saving) return
    setSaving(true)
    try {
      // Only include entries that have a new name
      const finalMapping: Record<string, string> = {}
      for (const [oldName, newName] of Object.entries(mapping)) {
        if (newName) finalMapping[oldName] = newName
      }
      await onSave(finalMapping)
      setExpanded(false)
      setMapping({})
      setCustomInputs({})
    } catch (err) {
      console.error('Speaker mapping failed:', err)
    }
    setSaving(false)
  }

  function handleSelect(speakerName: string, value: string) {
    if (value === '__custom__') {
      setCustomInputs((prev) => ({ ...prev, [speakerName]: true }))
      setMapping((prev) => ({ ...prev, [speakerName]: '' }))
    } else {
      setCustomInputs((prev) => ({ ...prev, [speakerName]: false }))
      setMapping((prev) => ({ ...prev, [speakerName]: value }))
    }
  }

  // Collapsed banner
  if (!expanded) {
    return (
      <div className="flex items-center justify-between bg-surface-secondary rounded-xl px-4 py-3 mb-4">
        <div className="flex items-center gap-2">
          <span className="w-1.5 h-1.5 rounded-full bg-accent" />
          <span className="text-sm text-text-secondary">
            {unmapped.length} unnamed speaker{unmapped.length > 1 ? 's' : ''}
          </span>
        </div>
        <button
          onClick={() => setExpanded(true)}
          className="text-sm text-accent hover:text-accent-hover transition-colors"
        >
          Identify
        </button>
      </div>
    )
  }

  // Expanded panel
  return (
    <div className="bg-surface-secondary rounded-xl px-5 py-4 mb-4">
      <h4 className="text-sm font-medium text-text-primary mb-4">Identify speakers</h4>

      <div className="space-y-5">
        {unmapped.map((speaker) => {
          const quotes = getRepresentativeQuotes(segments, speaker.name)
          const isCustom = customInputs[speaker.name]

          // Available attendees: exclude already-named speakers and already-assigned-in-this-session
          const available = attendees.filter(
            (a) =>
              !alreadyNamed.has(a.name) &&
              (!assignedNames.has(a.name) || mapping[speaker.name] === a.name)
          )

          return (
            <div key={speaker.name}>
              <div className="flex items-start justify-between gap-3 mb-2">
                <span className="text-xs font-medium text-speaker-remote">{speaker.name}</span>
                {isCustom ? (
                  <div className="flex items-center gap-1.5">
                    <input
                      type="text"
                      value={mapping[speaker.name] ?? ''}
                      onChange={(e) =>
                        setMapping((prev) => ({ ...prev, [speaker.name]: e.target.value }))
                      }
                      placeholder="Enter name..."
                      autoFocus
                      className="px-2.5 py-1 bg-surface-elevated border border-border/40 rounded-lg text-sm text-text-primary placeholder-text-muted outline-none focus:border-accent w-40 transition-colors"
                    />
                    <button
                      onClick={() => {
                        setCustomInputs((prev) => ({ ...prev, [speaker.name]: false }))
                        setMapping((prev) => ({ ...prev, [speaker.name]: '' }))
                      }}
                      className="text-xs text-text-muted hover:text-text-secondary transition-colors"
                    >
                      Cancel
                    </button>
                  </div>
                ) : (
                  <select
                    value={mapping[speaker.name] ?? ''}
                    onChange={(e) => handleSelect(speaker.name, e.target.value)}
                    className="px-2.5 py-1 bg-surface-elevated border border-border/40 rounded-lg text-sm text-text-primary outline-none focus:border-accent transition-colors"
                  >
                    <option value="">Select name...</option>
                    {available.map((a) => (
                      <option key={a.email} value={a.name}>
                        {a.name}
                      </option>
                    ))}
                    <option value="__custom__">Custom name...</option>
                  </select>
                )}
              </div>

              {quotes.length > 0 && (
                <div className="space-y-1.5 ml-0.5">
                  {quotes.map((q, i) => (
                    <p
                      key={i}
                      className="text-xs text-text-muted italic border-l-2 border-border/40 pl-3 leading-relaxed"
                    >
                      &ldquo;{q}&rdquo;
                    </p>
                  ))}
                </div>
              )}
            </div>
          )
        })}
      </div>

      <div className="flex justify-end gap-3 mt-5">
        <button
          onClick={() => {
            setExpanded(false)
            setMapping({})
            setCustomInputs({})
          }}
          className="px-3 py-1.5 text-sm text-text-secondary hover:text-text-primary transition-colors"
        >
          Cancel
        </button>
        <button
          onClick={handleSave}
          disabled={!hasChanges || saving}
          className="px-4 py-1.5 text-sm font-medium bg-accent text-white rounded-lg hover:bg-accent-hover disabled:opacity-40 transition-colors"
        >
          {saving ? 'Saving...' : 'Save Names'}
        </button>
      </div>
    </div>
  )
}
