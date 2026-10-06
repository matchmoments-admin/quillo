import { useId, type ReactNode } from "react";
import { Chip } from "./Chip";
import { FtCard, Skeleton, StatusGate, cx, type StatusProps } from "./primitives";

/**
 * One About you question (spec A2, #585): the question, a short help line, and either single-choice
 * options (one tap each, a tick plus the highlight fill when chosen) or custom controls as children (a
 * date picker, the occupation field, the tick-what-applies chips). Follow-ups (visa type, part-year
 * date) go in `children` under the options. `problem` is shown as a plain message, never silently.
 *
 * Exactly two options (Yes / No) render as one full-width either/or pair (pattern P8), from the same chips.
 * The problem line carries `problemId` (default: a generated id) and describes the fieldset, so a field
 * marked `invalid` can point its `aria-describedby` at the same id (pattern P5).
 */
export function SituationQuestion<K extends string>({
  title,
  help,
  options,
  value,
  onChange,
  problem,
  problemId,
  children,
  ...status
}: {
  title: ReactNode;
  help?: ReactNode;
  options?: readonly { key: K; label: ReactNode }[];
  value?: K | "";
  onChange?: (key: K) => void;
  problem?: string | null;
  problemId?: string;
  children?: ReactNode;
} & StatusProps) {
  const generated = useId();
  const errId = problemId ?? `${generated}-problem`;
  const pair = options?.length === 2;
  return (
    <FtCard className="p-5">
      <fieldset className="space-y-4" aria-describedby={problem ? errId : undefined}>
        <legend className="font-display text-xl tracking-wide text-forest">{title}</legend>
        {help && <p className="max-w-[65ch] text-sm leading-relaxed text-muted">{help}</p>}
        <StatusGate
          what="this question"
          {...status}
          skeleton={
            <div className="flex flex-wrap gap-2">
              {["w-28", "w-36", "w-24"].map((w) => (
                <Skeleton key={w} block className={`h-11 rounded-full ${w}`} />
              ))}
            </div>
          }
        >
          {options && options.length > 0 && (
            <div className={cx("gap-2", pair ? "grid grid-cols-2" : "flex flex-wrap")}>
              {options.map((o) => (
                <Chip key={o.key} selected={value === o.key} onToggle={() => onChange?.(o.key)} className={pair ? "w-full" : undefined}>
                  {o.label}
                </Chip>
              ))}
            </div>
          )}
          {children}
          {problem && (
            <p id={errId} role="alert" className="text-sm text-danger">
              {problem}
            </p>
          )}
        </StatusGate>
      </fieldset>
    </FtCard>
  );
}
