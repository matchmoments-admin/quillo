import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "../api";
import { useFeatures } from "../lib/features";
import { Card } from "./ui";

/**
 * "Recent changes — undo" feed (flag ai_edit_feed). Lists the audited entity writes (manual edits, and —
 * once ask_actions_v2 is on — AI-confirmed ones) newest first, each reversible with one click. Every undo
 * goes back through the DO (restores the prior snapshot / deletes a created row) and is itself audited.
 * Self-gates on the flag: renders nothing when off, so it's invisible until enabled.
 */
export function AiChangesFeed() {
  const { has } = useFeatures();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ["ai-edits"], queryFn: () => api.aiEdits(), enabled: has("ai_edit_feed") });
  const undo = useMutation({
    mutationFn: (actionId: string) => api.undoAiEdit(actionId),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: ["ai-edits"] });
      // The undo moved entity data — refresh the surfaces that read it.
      for (const k of ["situation", "dashboard", "rules", "report"]) qc.invalidateQueries({ queryKey: [k] });
    },
  });

  if (!has("ai_edit_feed")) return null;
  const edits = q.data ?? [];
  if (!edits.length) return null;

  return (
    <Card className="overflow-hidden">
      <div className="border-b border-line px-4 py-3 text-sm font-medium">Recent changes</div>
      <ul className="divide-y divide-line">
        {edits.slice(0, 12).map((e) => (
          <li key={e.action_id} className="flex items-center gap-3 px-4 py-2.5 text-sm">
            <span className={`rounded-full px-2 py-0.5 text-[10px] font-bold uppercase tracking-wide ${e.source === "ai_confirmed" ? "bg-sage/40 text-forest" : "bg-surface text-muted"}`}>
              {e.source === "ai_confirmed" ? "AI" : "You"}
            </span>
            <span className={`min-w-0 flex-1 truncate ${e.reverted_at ? "text-muted line-through" : "text-ink"}`}>{e.summary}</span>
            <span className="hidden flex-none text-xs text-muted sm:inline">{(e.created_at ?? "").replace("T", " ").slice(0, 16)}</span>
            {e.reverted_at ? (
              <span className="flex-none text-xs text-muted">undone</span>
            ) : (
              <button
                onClick={() => undo.mutate(e.action_id)}
                disabled={undo.isPending}
                className="flex-none rounded-lg border border-line bg-surface px-2.5 py-1 text-xs font-medium transition hover:bg-card disabled:opacity-50"
              >
                Undo
              </button>
            )}
          </li>
        ))}
      </ul>
    </Card>
  );
}
