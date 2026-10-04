import { Badge, FtButton, FtCard } from "./primitives";

// GrowSuggestionCard (spec A12 component list; used by A11 ticket b, #592). One "Looks like you have X: add
// it?" suggestion with Yes / No. The card never acts on its own: Yes switches the layer on, No declines it
// for the year. Copy comes from the server (src/lib/grow.ts), which carries the general-information line.

export function GrowSuggestionCard({
  title,
  body,
  onYes,
  onNo,
  busy = false,
}: {
  title: string;
  body: string;
  onYes: () => void;
  onNo: () => void;
  busy?: boolean;
}) {
  return (
    <FtCard className="p-4">
      <div className="flex flex-wrap items-start gap-3">
        <Badge tone="highlight">Noticed</Badge>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-semibold text-ink">{title}</p>
          <p className="mt-0.5 max-w-[65ch] text-sm text-muted">{body}</p>
        </div>
      </div>
      <div className="mt-3 flex flex-wrap gap-2">
        <FtButton variant="primary" onClick={onYes} busy={busy}>
          Yes, add it
        </FtButton>
        <FtButton variant="ghost" onClick={onNo} disabled={busy}>
          No, not this year
        </FtButton>
      </div>
    </FtCard>
  );
}
