import React from "react";
import ReactDOM from "react-dom/client";
import { QueryClient, QueryClientProvider, MutationCache } from "@tanstack/react-query";
import { createBrowserRouter, RouterProvider, Navigate } from "react-router-dom";
import { ClerkProvider, SignIn, SignUp, SignedIn, SignedOut, RedirectToSignIn, useAuth } from "@clerk/clerk-react";
import "./index.css";
import { App } from "./App";
import { Inbox } from "./pages/Inbox";
import { Transactions } from "./pages/Transactions";
import { TxnDetail } from "./pages/TxnDetail";
import { Dashboard } from "./pages/Dashboard";
import { Notifications } from "./pages/Notifications";
import { Settings } from "./pages/Settings";
import { Onboarding } from "./pages/Onboarding";
import { QuickBooks } from "./pages/QuickBooks";
import { Reports } from "./pages/Reports";
import { Savings } from "./pages/Savings";
import { Review } from "./pages/Review";
import { Filing } from "./pages/Filing";
import { Admin } from "./pages/Admin";
import { Partner } from "./pages/Partner";
import { Accounts } from "./pages/Accounts";
import { Reconcile } from "./pages/Reconcile";
import { Income } from "./pages/Income";
import { Documents } from "./pages/Documents";
import { Assets } from "./pages/Assets";
import { Glossary } from "./pages/Glossary";
import { setTokenGetter } from "./api";
import { ActiveFyProvider } from "./lib/activeFy";
import { useFeatures } from "./lib/features";
import { Spinner } from "./components/ui";

// Research Slice 1: when `unified_transactions` is ON the Inbox review queue lives as the "Needs
// review" tab of the merged Transactions page, so /inbox (and every navigate("/inbox") / server
// next-action href that still points here) redirects into it. Flag OFF ⇒ the standalone Inbox, so
// the experience is unchanged. Wait for the flag to load before deciding to avoid a redirect flash.
function InboxRoute() {
  const { has, loaded } = useFeatures();
  if (!loaded) return <Spinner />;
  return has("unified_transactions") ? <Navigate to="/transactions?view=review" replace /> : <Inbox />;
}

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
  {
    path: "/",
    element: <Protected />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: "inbox", element: <InboxRoute /> },
      { path: "transactions", element: <Transactions /> },
      { path: "txn/:id", element: <TxnDetail /> },
      { path: "dashboard", element: <Dashboard /> },
      { path: "income", element: <Income /> },
      { path: "assets", element: <Assets /> },
      { path: "documents", element: <Documents /> },
      { path: "accounts", element: <Accounts /> },
      { path: "reconcile", element: <Reconcile /> },
      { path: "notifications", element: <Notifications /> },
      { path: "settings", element: <Settings /> },
      { path: "onboarding", element: <Onboarding /> },
      { path: "quickbooks", element: <QuickBooks /> },
      { path: "reports", element: <Reports /> },
      { path: "savings", element: <Savings /> },
      { path: "review", element: <Review /> },
      { path: "filing", element: <Filing /> },
      { path: "admin", element: <Admin /> },
      { path: "partner", element: <Partner /> },
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
