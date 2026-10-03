import type { ReactNode } from "react";
import { FtButton, Skeleton, StatusGate, cx, type StatusProps } from "./primitives";

/**
 * Chip (design-system.md §4): one tick-what-applies option. A toggle button (`aria-pressed`), with a
 * tick as well as the accent fill when selected so the state never relies on colour alone.
 */
export function Chip({
  selected,
  onToggle,
  disabled,
  children,
}: {
  selected: boolean;
  onToggle: () => void;
  disabled?: boolean;
  children: ReactNode;
}) {
  return (
    <FtButton
      variant="secondary"
      aria-pressed={selected}
      onClick={onToggle}
      disabled={disabled}
      className={cx("rounded-full px-4 text-sm font-medium", selected && "border-accent bg-accent-soft text-accent hover:bg-accent-soft")}
    >
      <span aria-hidden className={cx("inline-block w-3 text-center", !selected && "opacity-0")}>
        ✓
      </span>
      {children}
    </FtButton>
  );
}

/**
 * A labelled group of chips ("Tick what applies"), with the shared loading / empty / error states
 * for when the options come from the server.
 */
export function ChipGroup<K extends string>({
  label,
  options,
  selected,
  onToggle,
  ...status
}: {
  label: ReactNode;
  options: readonly { key: K; label: ReactNode }[];
  selected: readonly K[];
  onToggle: (key: K) => void;
} & StatusProps) {
  return (
    <fieldset className="space-y-2">
      <legend className="text-[15px] font-semibold text-ink">{label}</legend>
      <StatusGate
        what="the options"
        {...status}
        emptyTitle={status.emptyTitle ?? "No options to show"}
        skeleton={
          <div className="flex flex-wrap gap-2">
            {["w-24", "w-32", "w-20", "w-28"].map((w) => (
              <Skeleton key={w} block className={cx("h-11 rounded-full", w)} />
            ))}
          </div>
        }
      >
        <div className="flex flex-wrap gap-2">
          {options.map((o) => (
            <Chip key={o.key} selected={selected.includes(o.key)} onToggle={() => onToggle(o.key)}>
              {o.label}
            </Chip>
          ))}
        </div>
      </StatusGate>
    </fieldset>
  );
}
