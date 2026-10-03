import type { ReactNode } from "react";
import { Chip } from "./Chip";
import { FtCard, Skeleton, StatusGate, type StatusProps } from "./primitives";

/**
 * One About you question (spec A2, #585): the question, a short help line, and either single-choice
 * options (one tap each, a tick plus the accent fill when chosen) or custom controls as children (a
 * date picker, the occupation field, the tick-what-applies chips). Follow-ups (visa type, part-year
 * date) go in `children` under the options. `problem` is shown as a plain message, never silently.
 */
export function SituationQuestion<K extends string>({
  title,
  help,
  options,
  value,
  onChange,
  problem,
  children,
  ...status
}: {
  title: ReactNode;
  help?: ReactNode;
  options?: readonly { key: K; label: ReactNode }[];
  value?: K | "";
  onChange?: (key: K) => void;
  problem?: string | null;
  children?: ReactNode;
} & StatusProps) {
  return (
    <FtCard className="p-5">
      <fieldset className="space-y-4">
        <legend className="text-[19px] font-semibold leading-snug text-ink">{title}</legend>
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
            <div className="flex flex-wrap gap-2">
              {options.map((o) => (
                <Chip key={o.key} selected={value === o.key} onToggle={() => onChange?.(o.key)}>
                  {o.label}
                </Chip>
              ))}
            </div>
          )}
          {children}
          {problem && (
            <p role="alert" className="text-sm text-warn">
              {problem}
            </p>
          )}
        </StatusGate>
      </fieldset>
    </FtCard>
  );
}
