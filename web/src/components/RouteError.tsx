import { isRouteErrorResponse, useRouteError } from "react-router-dom";
import { BUTTON_BASE, BUTTON_TONE, CARD_CLASS } from "./ui";

/**
 * The router's errorElement (#696 design audit). Without one, an unknown URL — or /start while
 * ft_journey is OFF, whose loader throws a 404 — showed React Router's built-in developer screen
 * ("Unexpected Application Error! … Hey developer 👋") to real users, with no way back. This says what
 * happened in plain words and offers the way out. A 404 reads "page not found"; anything else is an
 * unexpected crash, and the user can reload or go home. Plain <a> links (not <Link>): the error can
 * fire outside the matched route tree, and a full load also clears whatever state broke the page.
 */
export function RouteError() {
  const error = useRouteError();
  const notFound = isRouteErrorResponse(error) && error.status === 404;
  return (
    <div className="grid min-h-screen place-items-center bg-paper p-6 text-ink">
      <div className={`${CARD_CLASS} w-full max-w-md p-6`}>
        <p className="text-[10px] font-bold uppercase tracking-[0.16em] text-muted">Quillo</p>
        <h1 className="mt-1 font-display text-3xl text-forest">{notFound ? "Page not found" : "Something went wrong"}</h1>
        <p className="mt-2 text-sm leading-relaxed text-muted">
          {notFound
            ? "That link doesn't go anywhere in Quillo. It may be old, or mistyped. Your records are safe."
            : "This page hit an unexpected problem. Your records are safe. Reload to try again, or go back to the start."}
        </p>
        <div className="mt-5 flex flex-wrap gap-2">
          <a href="/" className={`${BUTTON_BASE} ${BUTTON_TONE.primary}`}>
            Go to Quillo home
          </a>
          {!notFound && (
            <button type="button" onClick={() => window.location.reload()} className={`${BUTTON_BASE} ${BUTTON_TONE.ghost}`}>
              Reload
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
