import type { ReactNode } from "react";
import { FtButton, Skeleton, StatusGate, type StatusProps } from "./primitives";

export interface FooterAction {
  label: ReactNode;
  onClick?: () => void;
  disabled?: boolean;
  busy?: boolean;
}

/**
 * Step footer (design-system.md §4, pattern P7): two buttons, Back on the left and the primary on the
 * right. Why? sits in StepHeader beside "Step n of 4". Sticks to the bottom of the step on a phone
 * (clearing the iOS home indicator) and sits inline on wider screens. The agent explains, it never
 * drives: the user presses the primary action themselves.
 * `status="error"` shows the error above the buttons (the step's action failed) and keeps them usable.
 */
export function StepFooter({ onBack, primary, ...status }: { onBack?: () => void; primary?: FooterAction } & StatusProps) {
  const buttons = (
    <div className="flex items-center gap-2">
      {onBack && (
        <FtButton variant="ghost" onClick={onBack}>
          Back
        </FtButton>
      )}
      {primary && (
        <FtButton variant="primary" className="ml-auto" onClick={primary.onClick} disabled={primary.disabled} busy={primary.busy}>
          {primary.label}
        </FtButton>
      )}
    </div>
  );
  return (
    <footer className="sticky bottom-0 z-10 -mx-4 border-t border-line bg-paper/95 px-4 pb-[calc(0.75rem+env(safe-area-inset-bottom,0px))] pt-3 md:static md:mx-0 md:border-0 md:bg-transparent md:px-0 md:pb-0">
      {status.status === "error" ? (
        <div className="space-y-3">
          <StatusGate what="this step" {...status} skeleton={null}>
            {null}
          </StatusGate>
          {buttons}
        </div>
      ) : (
        <StatusGate
          what="the step actions"
          {...status}
          skeleton={
            <div className="flex items-center gap-2">
              <Skeleton block className="h-11 w-20 rounded-lg" />
              <Skeleton block className="ml-auto h-11 w-32 rounded-lg" />
            </div>
          }
        >
          {buttons}
        </StatusGate>
      )}
    </footer>
  );
}
