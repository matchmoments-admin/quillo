import { useMutation, useQueryClient } from "@tanstack/react-query";
import { api } from "../../api";
import { FtButton } from "../ft";
import type { PayrollLink } from "../../types";

/**
 * wages_relink: a wages card the user already said Yes to, whose employer's income statement still isn't recorded.
 * Either it's one of the income statements on file under another name (pick it), or it was never pay (undo the Yes).
 * "Not yet added" needs no button: the card just stays until the statement arrives.
 */
export function PayrollLinkCard({ link }: { link: PayrollLink }) {
  const qc = useQueryClient();
  const answer = useMutation({
    mutationFn: (body: { employer_name: string } | { not_pay: true }) => api.relinkNoticed(link.signal_id, body),
    onSuccess: () => { for (const k of ["noticed-links", "noticed", "readiness", "journey", "report", "transactions"]) qc.invalidateQueries({ queryKey: [k] }); },
  });
  return (
    <div className="rounded-2xl border border-line bg-card p-4 shadow-card">
      <p className="text-sm font-semibold text-ink">You said {link.employer} pays you. Its income statement isn't added yet.</p>
      <p className="mt-1 max-w-[65ch] text-sm text-muted">
        {link.choices.length
          ? "Your bank may name your employer differently from the income statement. If it's one of these, pick it. If these deposits aren't pay at all (an insurance claim, rent from your agent), say so."
          : "When your employer marks it \"Tax ready\" in myGov, add it on Connect. If these deposits aren't pay at all (an insurance claim, rent from your agent), say so."}
      </p>
      <div className="mt-3 flex flex-wrap gap-2">
        {link.choices.map((c) => (
          <FtButton key={c} onClick={() => answer.mutate({ employer_name: c })} busy={answer.isPending && answer.variables && "employer_name" in answer.variables && answer.variables.employer_name === c}>
            It's {c}
          </FtButton>
        ))}
        <FtButton variant="ghost" onClick={() => answer.mutate({ not_pay: true })} disabled={answer.isPending}>
          This isn't pay
        </FtButton>
      </div>
      {answer.error && (
        <p role="alert" className="mt-2 text-sm text-danger">
          {(answer.error as Error).message}
        </p>
      )}
    </div>
  );
}
