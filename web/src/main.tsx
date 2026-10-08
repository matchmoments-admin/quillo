import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router-dom";
import { ClerkProvider, SignIn, SignUp, SignedIn, SignedOut, RedirectToSignIn, useAuth } from "@clerk/clerk-react";
import "./index.css";
import { App } from "./App";
import { Transactions } from "./pages/Transactions";
import { TxnDetail } from "./pages/TxnDetail";
import { Dashboard } from "./pages/Dashboard";
import { Notifications } from "./pages/Notifications";
import { Settings } from "./pages/Settings";
import { Onboarding } from "./pages/Onboarding";
import { QuickBooks } from "./pages/QuickBooks";
import { Reports } from "./pages/Reports";
import { Savings } from "./pages/Savings";
import { Extras } from "./pages/Extras";
import { Billing } from "./pages/Billing";
import { Filing } from "./pages/Filing";
import { Admin } from "./pages/Admin";
import { SecurityCompliance } from "./pages/SecurityCompliance";
import { Partner } from "./pages/Partner";
import { Accounts } from "./pages/Accounts";
import { Reconcile } from "./pages/Reconcile";
import { Income } from "./pages/Income";
import { Documents } from "./pages/Documents";
import { Assets } from "./pages/Assets";
import { Glossary } from "./pages/Glossary";
import { BeforeYouStart, beforeYouStartLoader } from "./pages/BeforeYouStart";
import { GrowRoute } from "./pages/Grow";
import { FtRedirect, HomeIndex, OldStepRedirect, SetupStep, ConnectStep, ReviewStep, LodgeStep, LodgePrintStep } from "./pages/Steps";
import { setTokenGetter } from "./api";
import { ActiveFyProvider } from "./lib/activeFy";

const PUBLISHABLE_KEY = import.meta.env.VITE_CLERK_PUBLISHABLE_KEY as string | undefined;

const queryClient: QueryClient = new QueryClient({
  // The completion spine + per-tab guides read ["progress"]; the Filing page's year-end position
  // reads ["filing-readiness", fy]. Any successful mutation (confirming a category, dating an item,
  // importing, linking income, splitting a loan…) can change that derived state, so refresh both
  // once, centrally, after every write — rather than refetching on every navigation. Without the
  // filing-readiness invalidation, the global 30s staleTime would let the Filing page show a stale
  // position for up to 30s after an Inbox action (e.g. a loan split that moves the headline) — a real
  // risk since that figure is handed to an accountant. invalidateQueries only refetches the query
  // when it's mounted; otherwise it just marks it stale for the next visit. onSuccess runs after
  // queryClient is assigned, so the closure reference is safe.
  mutationCache: new MutationCache({
    onSuccess: () => {
      queryClient.invalidateQueries({ queryKey: ["progress"] });
      queryClient.invalidateQueries({ queryKey: ["filing-readiness"] });
      // #582 (ft_journey): the shell's step dots + Home read ["journey", fy]. With the flag OFF the
      // query never exists, so this is a no-op (no request).
      queryClient.invalidateQueries({ queryKey: ["journey"] });
    },
  }),
  // refetchOnWindowFocus was causing visible flashing: every time the tab regained focus
  // (e.g. switching back from the Intuit dashboard) ALL queries refetched at once. Off by
  // default; pages that genuinely need polling opt in explicitly (e.g. Accounts statements).
  defaultOptions: { queries: { refetchOnWindowFocus: false, staleTime: 30_000 } },
});

// Bridges Clerk's getToken into the plain api.ts module so every /api call is Bearer-authed.
function TokenBridge() {
  const { getToken } = useAuth();
  setTokenGetter(() => getToken());
  return null;
}

// Centred card wrapper for the Clerk auth widgets.
function AuthScreen({ children }: { children: React.ReactNode }) {
  return <div className="grid min-h-screen place-items-center bg-paper p-6">{children}</div>;
}

// Everything under "/" requires a signed-in user; signed-out visitors go to sign-in.
function Protected() {
  return (
    <>
      <SignedIn>
        <TokenBridge />
        <ActiveFyProvider>
          <App />
        </ActiveFyProvider>
      </SignedIn>
      <SignedOut>
        <RedirectToSignIn />
      </SignedOut>
    </>
  );
}

const router = createBrowserRouter([
  {
    path: "/sign-in/*",
    element: (
      <AuthScreen>
        <SignIn routing="path" path="/sign-in" signUpUrl="/sign-up" />
      </AuthScreen>
    ),
  },
  {
    path: "/sign-up/*",
    element: (
      <AuthScreen>
        <SignUp routing="path" path="/sign-up" signInUrl="/sign-in" />
      </AuthScreen>
    ),
  },
  // Public "Before you start" (#584, flag ft_journey) — outside <Protected />, beside sign-in. The
  // loader probes the public endpoint; flag OFF ⇒ it throws the router's standard 404, the same
  // screen an unknown path shows today.
  {
    path: "/start",
    loader: beforeYouStartLoader,
    element: <BeforeYouStart />,
  },
  {
    path: "/",
    element: <Protected />,
    children: [
      // ft_journey (#582): "/" is Home when ON; legacy pages wrapped in <FtRedirect> move to their
      // journey step when ON and render exactly as today when OFF (pages/Steps.tsx, lib/legacyRoutes.ts).
      { index: true, element: <HomeIndex /> },
      // The Inbox review queue is now the "Needs review" tab of Transactions; /inbox (and every
      // navigate("/inbox") / server next-action href that still points here) redirects in.
      { path: "inbox", element: <Navigate to="/transactions?view=review" replace /> },
      { path: "transactions", element: <FtRedirect><Transactions /></FtRedirect> },
      { path: "txn/:id", element: <TxnDetail /> },
      { path: "dashboard", element: <FtRedirect><Dashboard /></FtRedirect> },
      { path: "income", element: <FtRedirect><Income /></FtRedirect> },
      { path: "assets", element: <FtRedirect><Assets /></FtRedirect> },
      { path: "documents", element: <FtRedirect><Documents /></FtRedirect> },
      { path: "accounts", element: <FtRedirect><Accounts /></FtRedirect> },
      { path: "reconcile", element: <FtRedirect><Reconcile /></FtRedirect> },
      { path: "notifications", element: <Notifications /> },
      { path: "settings", element: <Settings /> },
      { path: "onboarding", element: <FtRedirect><Onboarding /></FtRedirect> },
      { path: "quickbooks", element: <FtRedirect><QuickBooks /></FtRedirect> },
      { path: "reports", element: <Reports /> },
      { path: "savings", element: <FtRedirect><Savings /></FtRedirect> },
      { path: "extras", element: <FtRedirect><Extras /></FtRedirect> },
      { path: "billing", element: <Billing /> },
      { path: "filing", element: <FtRedirect><Filing /></FtRedirect> },
      { path: "admin", element: <Admin /> },
      { path: "admin/security", element: <SecurityCompliance /> },
      { path: "partner", element: <Partner /> },
      // Journey steps — four since the design review (spec §0, #585). OFF ⇒ each redirects to the legacy
      // page it replaces, except /review, which IS the legacy "By label" page when OFF (rendered in place).
      { path: "setup", element: <SetupStep /> },
      { path: "connect", element: <ConnectStep /> },
      { path: "review", element: <ReviewStep /> },
      { path: "review/match", element: <ReviewStep /> },
      { path: "lodge", element: <LodgeStep /> },
      { path: "lodge/print", element: <LodgePrintStep /> },
      // The 6-step journey's URLs (#582) → their 4-step route (lib/legacyRoutes.ts OLD_STEP_ROUTES).
      { path: "about", element: <OldStepRedirect /> },
      { path: "bring-in", element: <OldStepRedirect /> },
      { path: "claims", element: <OldStepRedirect /> },
      { path: "records", element: <OldStepRedirect /> },
      { path: "check", element: <OldStepRedirect /> },
      { path: "check/match", element: <OldStepRedirect /> },
      { path: "ship", element: <OldStepRedirect /> },
      // Grow layer pages (ft_journey, #592; OFF ⇒ each redirects to the legacy page it composes).
      { path: "grow/:layer", element: <GrowRoute /> },
      { path: "glossary", element: <Glossary /> },
    ],
  },
]);

if (!PUBLISHABLE_KEY) {
  // Fail loudly at startup rather than silently shipping an unauthenticated app.
  throw new Error("VITE_CLERK_PUBLISHABLE_KEY is not set — see web/.env");
}

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <ClerkProvider publishableKey={PUBLISHABLE_KEY} afterSignOutUrl="/sign-in">
      <QueryClientProvider client={queryClient}>
        <RouterProvider router={router} />
      </QueryClientProvider>
    </ClerkProvider>
  </React.StrictMode>,
);
