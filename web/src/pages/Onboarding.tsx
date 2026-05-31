import { useQuery, useMutation, useQueryClient } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "../api";
import { Card, Spinner } from "../components/ui";

const CONSENT_TEXT =
  "I consent to my receipt and transaction data being processed by Anthropic (USA) for OCR and " +
  "categorisation (Australian Privacy Principle 8 cross-border disclosure). I understand I can switch " +
  "to AU-resident processing (Bedrock Sydney) instead.";

export function Onboarding() {
  const qc = useQueryClient();
  const sit = useQuery({ queryKey: ["situation"], queryFn: () => api.situation() });
  const consent = useMutation({
    mutationFn: () => api.consent(CONSENT_TEXT),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["situation"] }),
  });

  if (sit.isLoading) return <Spinner />;
  const s = sit.data;
  const usingBedrock = s?.profile?.inference_provider === "bedrock";
  const hasConsent = (s?.profile?.consent_xborder ?? 0) === 1 || usingBedrock;
  const hasEntities = (s?.entities.length ?? 0) > 0;
  const hasProps = (s?.properties.length ?? 0) > 0;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Get set up</h1>
      <p className="text-sm text-muted">A few one-time steps so the agent categorises accurately for your situation.</p>

      <Step n={1} done={hasConsent} title="Cross-border processing consent (APP 8)">
        {usingBedrock ? (
          <p className="text-sm text-muted">You're on AU-resident inference (Bedrock) — no US consent needed.</p>
        ) : hasConsent ? (
          <p className="text-sm text-safe">Consent recorded.</p>
        ) : (
          <>
            <p className="mb-3 text-sm text-muted">{CONSENT_TEXT}</p>
            <button
              onClick={() => consent.mutate()}
              disabled={consent.isPending}
              className="rounded-lg bg-ink px-4 py-2 text-sm font-medium text-white hover:bg-ink/90 disabled:opacity-50"
            >
              {consent.isPending ? "Recording…" : "I consent"}
            </button>
          </>
        )}
      </Step>

      <Step n={2} done={hasEntities} title="Register your entities">
        <p className="text-sm text-muted">
          Add your company, employment and novated lease in{" "}
          <Link to="/settings" className="text-accent">
            Settings
          </Link>
          . {hasEntities ? `${s?.entities.length} registered.` : "None yet."}
        </p>
      </Step>

      <Step n={3} done={hasProps} title="Add your properties">
        <p className="text-sm text-muted">
          Add each investment property (rented/vacant) in{" "}
          <Link to="/settings" className="text-accent">
            Settings
          </Link>
          {" "}so expenses attribute correctly. {hasProps ? `${s?.properties.length} added.` : "None yet."}
        </p>
      </Step>

      <Step n={4} done={false} title="Connect a capture device">
        <p className="text-sm text-muted">
          Mint an ingest key under Devices in{" "}
          <Link to="/settings" className="text-accent">
            Settings
          </Link>
          , then paste it into the Android app. Or just forward receipts to your email mailbox.
        </p>
      </Step>

      {hasConsent && hasEntities && (
        <Card className="bg-safe/5 p-4 text-sm text-safe">You're ready — start reviewing receipts in the Inbox.</Card>
      )}
    </div>
  );
}

function Step({ n, done, title, children }: { n: number; done: boolean; title: string; children: React.ReactNode }) {
  return (
    <Card className="p-4">
      <div className="mb-2 flex items-center gap-2">
        <span className={`grid h-6 w-6 place-items-center rounded-full text-xs font-bold ${done ? "bg-safe text-white" : "bg-line text-muted"}`}>
          {done ? "✓" : n}
        </span>
        <h2 className="font-medium">{title}</h2>
      </div>
      <div className="pl-8">{children}</div>
    </Card>
  );
}
